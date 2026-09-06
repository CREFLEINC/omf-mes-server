import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { MaterialIssueShortageService, shortageLines } from './shortage.service';

type Args = Record<string, unknown>;

interface Component {
  bom_component_id: bigint;
  component_item_id: bigint;
  uom_id: bigint;
  required_qty: Prisma.Decimal;
}

function component(id: bigint, itemId: bigint, requiredQty: string): Component {
  return {
    bom_component_id: id,
    component_item_id: itemId,
    uom_id: 1n,
    required_qty: new Prisma.Decimal(requiredQty),
  };
}

/** W/O 한 행 + `bom_component` N 행 + 기출고 0행만 답하는 최소 스텁. */
function stub(components: Component[], issued: { item_id: bigint; issued_qty: string }[] = []) {
  const findManyCalls: Args[] = [];
  const prisma = {
    work_order: {
      findUnique: async () => ({
        order_qty: new Prisma.Decimal(100),
        routing_operation_id: 7n,
        production_plan: { bom_id: 3n, bom: { base_qty: new Prisma.Decimal(1) } },
      }),
    },
    bom_component: {
      findMany: async (args: Args) => {
        findManyCalls.push(args);
        return components;
      },
    },
    $queryRaw: async () =>
      issued.map((row) => ({ item_id: row.item_id, issued_qty: new Prisma.Decimal(row.issued_qty) })),
  };
  return {
    service: new MaterialIssueShortageService(prisma as unknown as PrismaService),
    findManyCalls,
  };
}

describe('자재 출고요청 shortage', () => {
  it('shortage 는 bom_component 를 품목으로 합친다', async () => {
    const { service } = stub([
      component(1n, 10n, '2'),
      component(2n, 11n, '0.5'),
      component(3n, 10n, '3'),
    ]);

    const { items } = await service.shortage({ workOrderId: 1 });

    // 품목 10 이 두 줄(2 + 3)이라 한 줄로 합쳐지고, 순서는 처음 나온 자리를 지킨다.
    expect(items.map((item) => item.itemId)).toEqual([10, 11]);
    expect(items.map((item) => item.requiredQty)).toEqual([500, 50]);
  });

  it('같은 품목이 둘이면 bomComponentId 가 널이다', async () => {
    const { service } = stub([component(1n, 10n, '2'), component(3n, 10n, '3'), component(2n, 11n, '1')]);

    const { items } = await service.shortage({ workOrderId: 1 });

    // ⛔ 키 생략이 아니라 널이다 — 계약이 `["integer","null"]` 이다(R-20).
    expect(items[0].bomComponentId).toBeNull();
    expect(items[1].bomComponentId).toBe(2);
  });

  it('부족이 음수면 0 이다', async () => {
    const { service } = stub([component(1n, 10n, '2')], [{ item_id: 10n, issued_qty: '250' }]);

    const { items } = await service.shortage({ workOrderId: 1 });

    expect(items[0]).toMatchObject({ requiredQty: 200, issuedQty: 250, shortageQty: 0 });
  });

  it('routing_operation_id 가 다른 라인은 담지 않는다', async () => {
    const { service, findManyCalls } = stub([component(1n, 10n, '2')]);

    await service.shortage({ workOrderId: 1 });

    // `release-plan.ts:104` 와 같은 where — NULL 인 라인도 다른 공정의 라인도 안 담긴다.
    expect(findManyCalls[0].where).toEqual({ bom_id: 3n, routing_operation_id: 7n });
  });

  it('합칠 라인이 없으면 빈 목록이다', () => {
    expect(shortageLines([], new Map())).toEqual([]);
  });
});
