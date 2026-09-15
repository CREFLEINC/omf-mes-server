import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { materialRequirements } from './material-issue';
import { operationSettings } from './release-plan';
import { WorkOrderReleaseService } from './work-order-release.service';

const WORK_ORDER = 900;
const ROUTING_OPERATION = 33n;
const BOM = 44n;

type Row = Record<string, unknown>;

const component = (id: bigint, requiredQty: number): Row => ({
  bom_component_id: id,
  component_item_id: id + 100n,
  uom_id: 22n,
  required_qty: new Prisma.Decimal(requiredQty),
});

function stub(options: {
  typeCode?: string;
  destination?: bigint | null;
  fgDestination?: bigint | null;
  scrapDestination?: bigint | null;
  components?: Row[];
}) {
  /** 부른 순서 — 채번이 트랜잭션 «밖»인지 이 배열이 가른다. */
  const calls: string[] = [];
  const updated: Row[] = [];
  const lots: Row[] = [];
  const requests: Row[] = [];
  const lines: Row[] = [];
  const componentWheres: Row[] = [];

  const row = {
    order_qty: new Prisma.Decimal(100),
    item_id: 11n,
    uom_id: 22n,
    routing_operation_id: ROUTING_OPERATION,
    work_order_type_code: options.typeCode ?? 'NORMAL',
    default_wip_location_id: options.destination === undefined ? 77n : options.destination,
    default_fg_location_id: options.fgDestination === undefined ? 78n : options.fgDestination,
    default_scrap_location_id: options.scrapDestination === undefined ? 79n : options.scrapDestination,
    routing_operation: { standard_cycle_time_sec: null, standard_yield_rate: null },
    production_plan: {
      bom_id: BOM,
      bom: { bom_version: 2, base_qty: new Prisma.Decimal(1) },
      production_order: { plant_id: 5n },
    },
  };

  const tx = {
    $queryRaw: () => Promise.resolve([{ status_code: 'PLANNED', released_at: null, version_no: 1 }]),
    work_order: {
      update: ({ data }: { data: Row }) => {
        updated.push(data);
        return Promise.resolve({});
      },
    },
    lot: {
      count: () => Promise.resolve(0),
      create: ({ data }: { data: Row }) => {
        lots.push(data);
        return Promise.resolve({ lot_id: BigInt(lots.length) });
      },
      findMany: () => Promise.resolve([]),
    },
    material_issue_request: {
      create: ({ data }: { data: Row }) => {
        requests.push(data);
        return Promise.resolve({ material_issue_request_id: 9n });
      },
    },
    material_issue_request_line: {
      createMany: ({ data }: { data: Row[] }) => {
        lines.push(...data);
        return Promise.resolve({ count: data.length });
      },
      // 기출고를 되짚는 축을 물리려고 방금 만든 라인을 되읽는다(P-16) — 번호 그대로 id 를 짓는다.
      findMany: () =>
        Promise.resolve(
          lines.map((line) => ({
            material_issue_request_line_id: BigInt(Number(line.line_no)),
            line_no: Number(line.line_no),
          })),
        ),
    },
  };

  const prisma = {
    work_order: { findUnique: () => Promise.resolve(row) },
    // 가용 재고가 없다 — 피킹 지시는 0건이고 채번도 안 부른다(피킹 규칙은 `core/picking` spec).
    inventory_balance: { findMany: () => Promise.resolve([]) },
    item: { findMany: () => Promise.resolve([]) },
    bom_component: {
      findMany: ({ where }: { where: Row }) => {
        componentWheres.push(where);
        return Promise.resolve(options.components ?? []);
      },
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      calls.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const numbering = {
    next: () => {
      calls.push('numbering');
      return Promise.resolve('MIR-20260906-0001');
    },
  } as unknown as NumberingService;

  const service = new WorkOrderReleaseService(
    prisma,
    new DocumentStateService(),
    numbering,
    new LotRegistryService(new LotHoldService()),
  );
  return { service, calls, updated, lots, requests, lines, componentWheres };
}

const release = (harness: ReturnType<typeof stub>, lotSize = 50) =>
  harness.service.release(WORK_ORDER, 1, { lotSize }, 7);

describe('W/O 확정·배포 (I-6 PR ⑤b)', () => {
  it('배포 — 긴급 유형이면 출고요청을 만들지 않는다', async () => {
    const harness = stub({ typeCode: 'EMERGENCY' });

    await release(harness);

    // 슬롯은 «생긴다» — 긴급 경로에서도 선발행은 일어난다(계약).
    expect(harness.lots).toHaveLength(2);
    expect(harness.updated[0]).toMatchObject({ status_code: 'RELEASED' });
    // ⑨를 통째로 건너뛰므로 BOM 을 읽지도, 번호를 뽑지도 않는다.
    expect(harness.componentWheres).toEqual([]);
    expect(harness.requests).toEqual([]);
    expect(harness.calls).not.toContain('numbering');
  });

  it('배포 — 재작업 유형은 제외 대상이 아니다', async () => {
    const harness = stub({ typeCode: 'REWORK', components: [component(1n, 2)] });

    await release(harness);

    // 계약이 `EMERGENCY` 만 적었다 — 「재작업도 비슷하니까」로 넓히지 않는다.
    expect(harness.requests).toHaveLength(1);
    expect(harness.lines).toHaveLength(1);
  });

  it('배포 — 소요 = `required_qty × orderQty ÷ base_qty` 이고 스크랩률을 곱하지 않는다', () => {
    const lines = materialRequirements(
      [component(1n, 2.5) as never, component(2n, 0.3) as never],
      new Prisma.Decimal(1000),
      new Prisma.Decimal(4),
    );

    // 2.5 × 1000 ÷ 4 = 625 · 0.3 × 1000 ÷ 4 = 75. 스크랩률 5% 를 곱했다면 656.25·78.75 다.
    expect(lines.map((line) => line.requested_qty.toString())).toEqual(['625', '75']);
    expect(lines.map((line) => line.line_no)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({ bom_component_id: 1n, item_id: 101n, uom_id: 22n });
  });

  it('배포 — 이 공정의 BOM 라인만 담고 공정 미지정 라인은 안 담는다', async () => {
    const harness = stub({ components: [component(1n, 2)] });

    await release(harness);

    // ⛔ `routing_operation_id` 를 «값으로» 걸므로 `IS NULL` 행은 애초에 안 걸린다.
    expect(harness.componentWheres).toEqual([
      { bom_id: BOM, routing_operation_id: ROUTING_OPERATION },
    ]);
  });

  it('배포 — 담을 라인이 0건이면 헤더도 만들지 않는다', async () => {
    const harness = stub({ components: [] });

    await release(harness);

    expect(harness.requests).toEqual([]);
    expect(harness.lines).toEqual([]);
    // 0건을 알고 나서 채번하므로 결번도 안 난다.
    expect(harness.calls).not.toContain('numbering');
  });

  it('배포 — 기본 위치가 빠지면 세 필드의 400을 내고 아무 결과도 쓰지 않는다', async () => {
    const harness = stub({
      destination: null,
      fgDestination: null,
      scrapDestination: null,
      components: [component(1n, 2)],
    });

    let caught: unknown;
    try {
      await release(harness);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toEqual([
      expect.objectContaining({ field: 'defaultWipLocationId', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'defaultFgLocationId', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'defaultScrapLocationId', code: 'REQUIRED' }),
    ]);
    expect(harness.updated).toEqual([]);
    expect(harness.lots).toEqual([]);
    expect(harness.requests).toEqual([]);
    expect(harness.componentWheres).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('배포 — 채번은 `$transaction` 을 열기 전에 부른다', async () => {
    const harness = stub({ components: [component(1n, 2)] });

    await release(harness);

    // 트랜잭션 «안»에서 부르면 한 요청이 커넥션을 둘 쥔다.
    expect(harness.calls).toEqual(['numbering', 'transaction']);
    expect(harness.requests[0]).toMatchObject({
      issue_request_no: 'MIR-20260906-0001',
      destination_location_id: 77n,
      status_code: 'REGISTERED',
      requested_by: 7,
      created_by: 7,
    });
    // 받는 칸이 없어 비운다 — Prisma 에 키를 안 넘긴다.
    expect(Object.keys(harness.requests[0])).not.toContain('required_at');
    expect(Object.keys(harness.requests[0])).not.toContain('reason_code');
  });

  it('배포 — 스냅샷은 표준 사이클타임·수율 두 키만 굳히고 NULL 은 키를 생략한다', () => {
    const decimal = (value: number) => new Prisma.Decimal(value);

    expect(
      operationSettings({ standard_cycle_time_sec: decimal(12.5), standard_yield_rate: decimal(0.97) }),
    ).toEqual({ standardCycleTimeSec: 12.5, standardYieldRate: 0.97 });
    expect(
      operationSettings({ standard_cycle_time_sec: null, standard_yield_rate: decimal(0.97) }),
    ).toEqual({ standardYieldRate: 0.97 });
    // 계약 example 이 든 두 키 밖은 지어내지 않는다 — 둘 다 NULL 이면 빈 객체다(R-27).
    expect(operationSettings({ standard_cycle_time_sec: null, standard_yield_rate: null })).toEqual({});
  });
});
