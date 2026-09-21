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
  /** 배포 전제 — 라인의 공장(omf-all-around#36). `null` 이면 라인이 없는 W/O 다. */
  linePlant?: bigint | null;
  /** 라우팅이 「검사 공정」이라 적었는가 — PQC 의뢰의 opt-in 축(omf-all-around#46). */
  inspectionManaged?: boolean;
  /** 이 공정에 유효한 PQC 기준 버전들. 비면 기준 없이 의뢰만 선다. */
  pqcVersions?: Row[];
  /** 이미 살아 있는 PQC 의뢰가 있는가 — 있으면 또 만들지 않는다. */
  pqcExists?: boolean;
}) {
  /** 부른 순서 — 채번이 트랜잭션 «밖»인지 이 배열이 가른다. */
  const calls: string[] = [];
  const updated: Row[] = [];
  const lots: Row[] = [];
  const requests: Row[] = [];
  const lines: Row[] = [];
  const componentWheres: Row[] = [];
  const inspectionRequests: Row[] = [];

  const row = {
    order_qty: new Prisma.Decimal(100),
    item_id: 11n,
    uom_id: 22n,
    routing_operation_id: ROUTING_OPERATION,
    work_order_type_code: options.typeCode ?? 'NORMAL',
    default_wip_location_id: options.destination === undefined ? 77n : options.destination,
    default_fg_location_id: options.fgDestination === undefined ? 78n : options.fgDestination,
    default_scrap_location_id: options.scrapDestination === undefined ? 79n : options.scrapDestination,
    // 배포 전제 — 기본은 계획 공장(5n)과 같은 라인이다(omf-all-around#36).
    production_line_id: options.linePlant === null ? null : 33n,
    production_line: options.linePlant === null ? null : { plant_id: options.linePlant ?? 5n },
    routing_operation: {
      standard_cycle_time_sec: null,
      standard_yield_rate: null,
      inspection_managed: options.inspectionManaged ?? false,
      process_id: 66n,
      routing_id: 77n,
    },
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
    inspection_request: {
      findFirst: () =>
        Promise.resolve(options.pqcExists === true ? { inspection_request_id: 1n } : null),
      create: ({ data }: { data: Row }) => {
        inspectionRequests.push(data);
        return Promise.resolve({ inspection_request_id: 5n });
      },
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
    inspection_plan_version: { findMany: () => Promise.resolve(options.pqcVersions ?? []) },
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
    next: (documentTypeCode: string) => {
      calls.push(documentTypeCode === 'INSPECTION_REQUEST' ? 'numbering:pqc' : 'numbering');
      return Promise.resolve(
        documentTypeCode === 'INSPECTION_REQUEST' ? 'IRQ-20260921-0001' : 'MIR-20260906-0001',
      );
    },
  } as unknown as NumberingService;

  const service = new WorkOrderReleaseService(
    prisma,
    new DocumentStateService(),
    numbering,
    new LotRegistryService(new LotHoldService()),
  );
  return { service, calls, updated, lots, requests, lines, componentWheres, inspectionRequests };
}

const release = (harness: ReturnType<typeof stub>, lotSize = 50) =>
  harness.service.release(WORK_ORDER, 1, { lotSize }, 7);

describe('W/O 확정·배포 (I-6 PR ⑤b)', () => {
  /*
   * ⭐ PQC 의뢰는 **라우팅이 검사 공정이라 적은 공정**에만 선다(설계 REQ-OA-0003 opt-in).
   *    그전까지 서버에 PQC 의뢰를 만드는 코드가 없어 P-02-13 이 열릴 대상이 없었다(#46).
   */
  it('PQC — 검사 공정이 아니면 의뢰를 만들지 않는다', async () => {
    const harness = stub({});

    await release(harness);

    expect(harness.inspectionRequests).toEqual([]);
    expect(harness.calls).not.toContain('numbering:pqc');
  });

  it('PQC — 검사 공정이면 작업지시 대상 의뢰 한 건을 만든다', async () => {
    const harness = stub({
      inspectionManaged: true,
      pqcVersions: [
        {
          inspection_plan_version_id: 501n,
          sampling_method_code: 'FULL_INSPECTION',
          sampling_qty: null,
          sampling_ratio: null,
          inspection_plan: { process_id: 66n, routing_id: null },
        },
      ],
    });

    await release(harness);

    expect(harness.inspectionRequests).toHaveLength(1);
    expect(harness.inspectionRequests[0]).toMatchObject({
      inspection_request_no: 'IRQ-20260921-0001',
      inspection_type_code: 'PQC',
      inspection_plan_version_id: 501n,
      target_type_code: 'WORK_ORDER',
      target_id: BigInt(WORK_ORDER),
      work_order_id: BigInt(WORK_ORDER),
      /* 공정검사는 실적 «전»이라 검사할 LOT 이 아직 없다(계약). */
      lot_id: null,
      status_code: 'REQUESTED',
    });
    /* 전수검사 — 지시수량 그대로. */
    expect(String(harness.inspectionRequests[0].target_qty)).toBe('100');
  });

  /* ⛔ 채번은 트랜잭션 «밖»이다 — 안에서 부르면 한 요청이 커넥션을 둘 쥔다. */
  it('PQC — 의뢰 번호를 트랜잭션 밖에서 뽑는다', async () => {
    const harness = stub({ inspectionManaged: true });

    await release(harness);

    expect(harness.calls.indexOf('numbering:pqc')).toBeLessThan(harness.calls.indexOf('transaction'));
  });

  /*
   * ⛔ **기준이 없다고 배포를 막지 않는다.** IQC·OQC 는 400 으로 막지만 배포는 훨씬 자주 도는
   *    액션이라 같은 규칙이면 기준 미등록 품목의 생산이 통째로 선다. 계약도 PQC 의뢰의
   *    기준이 비는 것을 허용한다.
   */
  it('PQC — 기준을 못 고르면 비운 채로 의뢰를 만든다', async () => {
    const harness = stub({ inspectionManaged: true, pqcVersions: [] });

    await release(harness);

    expect(harness.updated[0]).toMatchObject({ status_code: 'RELEASED' });
    expect(harness.inspectionRequests[0]).toMatchObject({ inspection_plan_version_id: null });
  });

  /* 샘플이면 검사 수량만 줄인다 — 어느 LOT 을 검사할지는 이 자리에서 정하지 않는다(#46 후속). */
  it('PQC — 샘플 비율이면 올림한 수량으로 선다', async () => {
    const harness = stub({
      inspectionManaged: true,
      pqcVersions: [
        {
          inspection_plan_version_id: 502n,
          sampling_method_code: 'SAMPLE_BY_UNIT',
          sampling_qty: null,
          sampling_ratio: new Prisma.Decimal(0.035),
          inspection_plan: { process_id: 66n, routing_id: null },
        },
      ],
    });

    await release(harness);

    /* 100 × 0.035 = 3.5 → 4. 밑돌지 않게 올린다. */
    expect(String(harness.inspectionRequests[0].target_qty)).toBe('4');
  });

  /* ⛔ 같은 W/O 에 살아 있는 의뢰가 있으면 또 만들지 않는다 — 물리 유니크가 없는 자리다. */
  it('PQC — 이미 살아 있는 의뢰가 있으면 만들지 않는다', async () => {
    const harness = stub({ inspectionManaged: true, pqcExists: true });

    await release(harness);

    expect(harness.inspectionRequests).toEqual([]);
  });

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

  /**
   * omf-all-around#36 — 단말 권한 검사는 «라인의 공장»으로 판정한다. 라인이 없거나 다른
   * 공장이면 배포는 되는데 현장 단말에서 전부 막힌다. 배포에서 먼저 가른다.
   */
  it('배포 — 생산라인이 비면 `productionLineId` REQUIRED 400 이고 아무 결과도 쓰지 않는다', async () => {
    const harness = stub({ linePlant: null, components: [component(1n, 2)] });

    let caught: unknown;
    try {
      await release(harness);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toEqual([
      expect.objectContaining({ field: 'productionLineId', code: 'REQUIRED' }),
    ]);
    expect(harness.updated).toEqual([]);
    expect(harness.lots).toEqual([]);
    expect(harness.requests).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('배포 — 라인이 다른 공장 것이면 `productionLineId` INVALID 400 이다', async () => {
    const harness = stub({ linePlant: 6n, components: [component(1n, 2)] });

    let caught: unknown;
    try {
      await release(harness);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toEqual([
      expect.objectContaining({ field: 'productionLineId', code: 'INVALID' }),
    ]);
    expect(harness.updated).toEqual([]);
    expect(harness.lots).toEqual([]);
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
