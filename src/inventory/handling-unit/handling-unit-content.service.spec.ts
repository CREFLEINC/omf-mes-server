import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlingUnitContentService } from './handling-unit-content.service';
import { HandlingUnitContentUpsert } from './handling-unit.service';

/**
 * e2e 가 «값으로» 못 재는 것만 확정한다(계획 §9-4 단위 3·5·6·7·12).
 *  ⓐ **자물쇠** — 치환은 오늘 언제나 200/400/404/409 로 닫히므로 `FOR UPDATE` 를 통째로
 *    빼도 e2e 가 전부 초록이다. 경쟁을 실제로 재는 시험은 저장소에 선례가 0이고,
 *    «원시 SQL 을 단위 스펙이 지켜보는» 선례가 많다(`stock-transfer-lock.spec.ts` 형).
 *  ⓑ **호출 순서** — 부모를 잠근 «뒤»에 치환 전 구성을 읽어야 두 치환이 겹칠 때
 *    `qty_before` 를 잃지 않는다. 순서를 뒤집어도 단일 요청 e2e 는 초록이다.
 *  ⓒ ⭐ **`Decimal` 보존** — `numeric(20,6)` 의 끝자리는 double 이 못 담는데, 그런 수량은
 *    JSON 요청으로 만들 수 없어(요청 `qty` 가 이미 double 이다) e2e 로 못 재는 자리다.
 */

const HU = 77;
const USER = 9;
const ITEM_A = 101;
const ITEM_B = 102;
const LOT_1 = 201;
const LOT_2 = 202;
const UOM_EA = 301;
const UOM_BOX = 302;

interface BeforeRow {
  item_id: bigint;
  lot_id: bigint;
  qty: Prisma.Decimal;
  uom_id: bigint;
}

interface EventLine {
  line_no: number;
  handling_unit_id: number;
  role_code: string;
  item_id: number;
  lot_id: number;
  qty_before: Prisma.Decimal | number;
  qty_after: Prisma.Decimal | number;
  uom_id_before: number | null;
  uom_id_after: number | null;
}

interface EventData {
  repack_type_code: string;
  performed_by: number;
  occurred_at: Date;
  lines: { create: EventLine[] };
}

interface Recorded {
  calls: string[];
  lockSql: string;
  lockValues: unknown[];
  event: EventData | undefined;
  bump: Record<string, unknown> | undefined;
}

function row(itemId: number, lotId: number, qty: string, uomId: number): BeforeRow {
  return {
    item_id: BigInt(itemId),
    lot_id: BigInt(lotId),
    qty: new Prisma.Decimal(qty),
    uom_id: BigInt(uomId),
  };
}

function fake(
  before: BeforeRow[],
  locked: { version_no: number } | null = { version_no: 3 },
  bumped = 1,
) {
  const recorded: Recorded = {
    calls: [],
    lockSql: '',
    lockValues: [],
    event: undefined,
    bump: undefined,
  };
  let contentReads = 0;

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.calls.push('lock');
      recorded.lockSql = strings.join('?');
      recorded.lockValues = values;
      return locked === null ? [] : [locked];
    },
    handling_unit_content: {
      findMany: async () => {
        contentReads += 1;
        recorded.calls.push(contentReads === 1 ? 'read-before' : 'read-after');
        return contentReads === 1 ? before : [];
      },
      deleteMany: async () => {
        recorded.calls.push('delete');
        return { count: before.length };
      },
      createMany: async ({ data }: { data: unknown[] }) => {
        recorded.calls.push('create');
        return { count: data.length };
      },
    },
    // 존재 확인은 이 스펙의 주제가 아니다 — 물은 것을 그대로 돌려줘 전건 통과시킨다.
    item: { findMany: async ({ where }: Where<'item_id'>) => idRows('item_id', where) },
    lot: { findMany: async ({ where }: Where<'lot_id'>) => idRows('lot_id', where) },
    uom: { findMany: async ({ where }: Where<'uom_id'>) => idRows('uom_id', where) },
    handling_unit_repack_event: {
      create: async ({ data }: { data: EventData }) => {
        recorded.calls.push('event');
        recorded.event = data;
        return {};
      },
    },
    handling_unit: {
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        recorded.calls.push('bump');
        recorded.bump = where;
        return { count: bumped };
      },
    },
  };

  const prisma = {
    worker: { count: async () => 1 },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      recorded.calls.push('transaction');
      return work(tx);
    },
  };
  return { service: new HandlingUnitContentService(prisma as unknown as PrismaService), recorded };
}

type Where<K extends string> = { where: Record<K, { in: number[] }> };

function idRows<K extends string>(key: K, where: Record<K, { in: number[] }>): Record<K, number>[] {
  return where[key].in.map((id) => ({ [key]: id }) as Record<K, number>);
}

const CONTEXT = { workerNo: 'W-1', appUserId: USER };

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
};

async function linesOf(
  before: BeforeRow[],
  items: HandlingUnitContentUpsert[],
): Promise<EventLine[]> {
  const { service, recorded } = fake(before);
  await service.replace(HU, undefined, items, CONTEXT);
  return (recorded.event as EventData).lines.create;
}

describe('구성 치환 — 자물쇠와 호출 순서(단위 3)', () => {
  it('⭐ 부모를 `$transaction` 안에서 `FOR UPDATE` 로 잠그고, 그 «뒤»에 치환 전 구성을 읽는다', async () => {
    const { service, recorded } = fake([row(ITEM_A, LOT_1, '10', UOM_EA)]);

    await service.replace(HU, undefined, [], CONTEXT);

    // ⛔ 잠금이 「전 구성 읽기」보다 먼저다 — 뒤집으면 두 치환이 겹칠 때 앞의 결과를 못 보고
    //    `qty_before` 를 잃는다(변이 19).
    expect(recorded.calls).toEqual([
      'transaction',
      'lock',
      'read-before',
      'delete',
      'create',
      'event',
      'bump',
      'read-after',
    ]);
    expect(recorded.lockSql).toContain('FOR UPDATE');
    expect(recorded.lockSql).toContain('FROM inventory.handling_unit\n');
    expect(recorded.lockSql).toContain('WHERE handling_unit_id =');
    expect(recorded.lockValues).toEqual([77n]);
  });

  it('⭐ 부모 → 자식 순서가 I-27 발행(`document-issue-simple-lock.ts` lockUnits)과 같다', async () => {
    const { service, recorded } = fake([]);

    await service.replace(HU, undefined, [], CONTEXT);

    // 저쪽은 부모 `FOR NO KEY UPDATE` → 자식 `FOR SHARE` 다. 우리도 부모가 먼저다 —
    // 자식을 먼저 만지면 오늘 병합된 발행 경로와 교착한다(자리 ②).
    expect(recorded.calls.indexOf('lock')).toBeLessThan(recorded.calls.indexOf('read-before'));
    expect(recorded.calls.indexOf('lock')).toBeLessThan(recorded.calls.indexOf('delete'));
  });

  it('잠근 행이 없으면 404 다 — 409 를 먼저 내지 않는다', async () => {
    const { service } = fake([], null);

    const error = await thrown(() => service.replace(HU, 3, [], CONTEXT));

    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('If-Match 가 있으면 잠근 버전과 대조하고, 없으면 건너뛴다(공유계약 C-9)', async () => {
    expect(await thrown(() => fake([]).service.replace(HU, 2, [], CONTEXT))).toBeInstanceOf(
      ConflictException,
    );
    await expect(fake([]).service.replace(HU, 3, [], CONTEXT)).resolves.toEqual({ items: [] });
    await expect(fake([]).service.replace(HU, undefined, [], CONTEXT)).resolves.toEqual({
      items: [],
    });
  });

  it('⭐ 버전 올리기가 «잠근 값»을 조건으로 건다 — 그 사이 값이 바뀌면 0행이다', async () => {
    const { service, recorded } = fake([]);

    await service.replace(HU, undefined, [], CONTEXT);

    expect(recorded.bump).toEqual({ handling_unit_id: HU, version_no: 3 });
  });

  it('⭐ 그 조건이 0행을 돌려주면 409 다 — 잠금이 사라진 날 조용한 200 이 되지 않는다', async () => {
    // 잠그고 비교했으니 오늘은 도달 불가다. 그래도 그물이 «살아 있는지» 잰다 —
    // 지워도 초록인 줄은 없는 줄이다(README §6-2).
    const error = await thrown(() => fake([], { version_no: 3 }, 0).service.replace(HU, undefined, [], CONTEXT));

    expect(error).toBeInstanceOf(ConflictException);
  });
});

describe('구성 치환 — 이력 라인 diff(단위 5·6)', () => {
  it('⭐ 세 갈래 — 유지=RESULT(전→후) · 신규=RESULT(0→후) · 제거=SOURCE(전→0)', async () => {
    const lines = await linesOf(
      [row(ITEM_A, LOT_1, '10', UOM_EA), row(ITEM_B, LOT_2, '7', UOM_BOX)],
      [
        { itemId: ITEM_A, lotId: LOT_1, qty: 4, uomId: UOM_EA },
        { itemId: ITEM_B, lotId: LOT_1, qty: 5, uomId: UOM_BOX },
      ],
    );

    expect(
      lines.map((line) => [line.role_code, line.item_id, line.lot_id, String(line.qty_before), String(line.qty_after)]),
    ).toEqual([
      // 제거된 줄 — `'SOURCE' > 'RESULT'` 라 DESC 가 위로 올린다.
      ['SOURCE', ITEM_B, LOT_2, '7', '0'],
      ['RESULT', ITEM_A, LOT_1, '10', '4'],
      ['RESULT', ITEM_B, LOT_1, '0', '5'],
    ]);
  });

  it('⛔ 변화가 «없어도» 라인을 남긴다 — qtyBefore === qtyAfter 로(통보 144ⓑ)', async () => {
    const lines = await linesOf(
      [row(ITEM_A, LOT_1, '10', UOM_EA)],
      [{ itemId: ITEM_A, lotId: LOT_1, qty: 10, uomId: UOM_EA }],
    );

    expect(lines).toHaveLength(1);
    expect([lines[0].role_code, String(lines[0].qty_before), String(lines[0].qty_after)]).toEqual([
      'RESULT',
      '10',
      '10',
    ]);
  });

  it('⭐ 헤더는 RECONFIGURE 고정 · 라인은 전부 경로의 그 HU · line_no 가 1부터다', async () => {
    const { service, recorded } = fake([row(ITEM_B, LOT_2, '7', UOM_BOX)]);

    await service.replace(HU, undefined, [{ itemId: ITEM_A, lotId: LOT_1, qty: 1, uomId: UOM_EA }], CONTEXT);

    const event = recorded.event as EventData;
    expect([event.repack_type_code, event.performed_by]).toEqual(['RECONFIGURE', USER]);
    expect(event.occurred_at).toBeInstanceOf(Date);
    expect(event.lines.create.map((line) => [line.line_no, line.handling_unit_id])).toEqual([
      [1, HU],
      [2, HU],
    ]);
  });

  it('⭐ 정렬 2차·3차 키 — 같은 role 안에서 item 오름차순, 같은 item 안에서 lot 오름차순', async () => {
    const lines = await linesOf(
      [],
      [
        { itemId: ITEM_B, lotId: LOT_1, qty: 1, uomId: UOM_EA },
        { itemId: ITEM_A, lotId: LOT_2, qty: 1, uomId: UOM_EA },
        { itemId: ITEM_A, lotId: LOT_1, qty: 1, uomId: UOM_EA },
      ],
    );

    expect(lines.map((line) => [line.line_no, line.item_id, line.lot_id])).toEqual([
      [1, ITEM_A, LOT_1],
      [2, ITEM_A, LOT_2],
      [3, ITEM_B, LOT_1],
    ]);
  });
});

describe('구성 치환 — 수량은 Decimal 그대로다(단위 7)', () => {
  it('⭐ `numeric(20,6)` 의 끝자리를 잃지 않는다 — `Number()` 로 접으면 이력이 거짓이 된다', async () => {
    // double 의 유효숫자를 넘는 값이다 — `Number('12345678901234.000001')` 은
    // `12345678901234` 로 접히고, 그러면 이력이 «실제로 있던 수량»과 다른 값을 적는다.
    const lines = await linesOf(
      [
        row(ITEM_A, LOT_1, '12345678901234.000001', UOM_EA),
        row(ITEM_B, LOT_2, '12345678901234.000002', UOM_EA),
      ],
      [],
    );

    expect(lines.map((line) => String(line.qty_before))).toEqual([
      '12345678901234.000001',
      '12345678901234.000002',
    ]);
  });
});

describe('⭐⭐ 구성 치환 — 단위 변경 이력(단위 12 · 통보 165 · R-2)', () => {
  it('⭐ (item, lot) 이 같고 «단위만» 바뀐 줄이 uom_id_before !== uom_id_after 로 남는다', async () => {
    // `uq_handling_unit_content` 가 `(handling_unit_id, item_id, lot_id)` 라 이 치환이
    // 성립한다. 두 칸을 안 채우면 이 사건은 `10 === 10` 「변화 없음」으로만 남는다.
    const lines = await linesOf(
      [row(ITEM_A, LOT_1, '10', UOM_EA)],
      [{ itemId: ITEM_A, lotId: LOT_1, qty: 10, uomId: UOM_BOX }],
    );

    expect(String(lines[0].qty_before)).toBe(String(lines[0].qty_after));
    expect([lines[0].uom_id_before, lines[0].uom_id_after]).toEqual([UOM_EA, UOM_BOX]);
    // ⛔ 두 칸이 같은 값이면(변이 27) 그 사건이 이력에서 사라진다.
    expect(lines[0].uom_id_before).not.toBe(lines[0].uom_id_after);
  });

  it('⭐ 없는 쪽은 NULL 이다 — 신규는 before 가, 제거는 after 가 «없는 값»이다', async () => {
    const lines = await linesOf(
      [row(ITEM_B, LOT_2, '7', UOM_BOX)],
      [{ itemId: ITEM_A, lotId: LOT_1, qty: 5, uomId: UOM_EA }],
    );

    expect(lines.map((line) => [line.role_code, line.uom_id_before, line.uom_id_after])).toEqual([
      ['SOURCE', UOM_BOX, null],
      ['RESULT', null, UOM_EA],
    ]);
  });
});
