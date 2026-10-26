import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultCorrect, ProductionResultCorrectService } from './production-result-correct.service';

const ORIGINAL_ID = 7000;
const WORK_ORDER = 900;
const OCCURRED_AT = new Date('2026-09-06T01:30:00.000Z');
const CORRECT_NO = 'PR-260906-0009';

type Row = Record<string, unknown>;

/** 뷰 매퍼가 읽는 칸을 다 채운 원본 행. `create` 가 받은 `data` 를 그 위에 얹는다. */
function originalRow(overrides: Row = {}): Row {
  return {
    production_result_id: BigInt(ORIGINAL_ID),
    production_result_no: 'PR-260906-0001',
    work_order_id: BigInt(WORK_ORDER),
    work_session_id: null,
    result_sequence: 1,
    corrects_production_result_id: null,
    good_qty: new Prisma.Decimal(10),
    defect_qty: new Prisma.Decimal(2),
    hold_qty: new Prisma.Decimal(0),
    scrap_qty: new Prisma.Decimal(0),
    rework_qty: new Prisma.Decimal(0),
    uom_id: 3n,
    result_source_code: 'MANUAL',
    occurred_at: OCCURRED_AT,
    recorded_at: new Date('2026-09-06T02:00:00.000Z'),
    // ⭐ 사건 칸 열이 «아니다» — 원본의 지연 사유가 정정본의 사유가 되지 않는다.
    late_entry_reason_code: 'SHIFT_HANDOVER',
    worker_id: 55n,
    equipment_id: null,
    mold_id: null,
    shift_id: null,
    terminal_id: null,
    status_code: 'CONFIRMED',
    remarks: null,
    correct_reason_code: null,
    idempotency_key: 'idem-0',
    created_by: 9n,
    ...overrides,
  };
}

interface StubOptions {
  original?: Row;
  /** W/O 상태. 없으면 진행 중이다. */
  workOrderStatus?: string;
  /** 원본 실적의 LOT 배분. 없으면 0건이다. */
  originalAllocations?: { lotId: number; lotNo: string; qty: number }[];
  /** 바뀌는 LOT 이 넘어간 곳(생산입고·포장·출하). 없으면 0건이다. */
  downstream?: Row[];
  maxSequence?: number | null;
  missing?: boolean;
  /** 원본을 가리키는 정정본 수. 없으면 0 이다. */
  correctedCount?: number;
  /** 원본의 유형별 내역(FIELD 기록). 없으면 0건이다. */
  originalDefects?: Row[];
}

function stub(options: StubOptions = {}) {
  const original = options.original ?? originalRow();
  const created: Row[] = [];
  const updated: Row[] = [];
  const allocated: Row[] = [];
  const defectsWritten: Row[] = [];
  const audits: Row[] = [];
  const sequenceWheres: Row[] = [];
  const numbered: unknown[][] = [];
  /** 부른 «차례» — 자물쇠 순서와 채번 위치가 판정 대상이다. */
  const order: string[] = [];

  const tx = {
    $queryRaw: (strings: TemplateStringsArray) => {
      if (strings.join('').includes('goods_receipt_line')) return Promise.resolve(options.downstream ?? []);
      const workOrderLock = strings.join('').includes('production.work_order');
      order.push(workOrderLock ? 'lock-work-order' : 'lock-result');
      return Promise.resolve(
        workOrderLock
          ? [
              {
                status_code: options.workOrderStatus ?? 'IN_PROGRESS',
                released_at: new Date('2026-09-06T00:00:00.000Z'),
                version_no: 1,
                order_qty: new Prisma.Decimal(100),
                planned_start_at: null,
                planned_end_at: null,
              },
            ]
          : [{ production_result_id: BigInt(ORIGINAL_ID) }],
      );
    },
    work_order: {
      findUniqueOrThrow: () => Promise.resolve({ work_order_no: 'WO-0900', completion_variance_reason_code: null }),
      update: () => Promise.resolve({}),
    },
    lot: {
      // 완료된 LOT 은 이 픽스처에 없다 — 완료 재판정 조회(`completed_at`)는 0건이다.
      findMany: ({ where }: { where: Row }) =>
        Promise.resolve('completed_at' in where ? [] : (options.originalAllocations ?? []).map((row) => ({ lot_id: BigInt(row.lotId), lot_no: row.lotNo }))),
    },
    document_issue_log: { findMany: () => Promise.resolve([]) },
    audit_event: {
      create: ({ data }: { data: Row }) => {
        audits.push(data);
        return Promise.resolve({});
      },
    },
    production_result: {
      // 원본 체인을 거슬러 오를 때는 원본의 원본 — 이 픽스처에선 배분 없는 맨 앞 행이다.
      findUniqueOrThrow: ({ where }: { where: { production_result_id: bigint } }) =>
        Promise.resolve(where.production_result_id === original.production_result_id
          ? original
          : { good_qty: original.good_qty, corrects_production_result_id: null }),
      count: () => Promise.resolve(options.correctedCount ?? 0),
      aggregate: ({ where }: { where: Row }) => {
        sequenceWheres.push(where);
        return Promise.resolve({ _max: { result_sequence: options.maxSequence ?? null } });
      },
      update: ({ data }: { data: Row }) => {
        updated.push(data);
        return Promise.resolve({});
      },
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({
          ...original,
          ...data,
          good_qty: new Prisma.Decimal(data.good_qty as number),
          defect_qty: new Prisma.Decimal(data.defect_qty as number),
          hold_qty: new Prisma.Decimal(data.hold_qty as number),
          scrap_qty: new Prisma.Decimal(data.scrap_qty as number),
          rework_qty: new Prisma.Decimal(data.rework_qty as number),
        });
      },
    },
    production_result_lot_allocation: {
      findMany: () =>
        Promise.resolve((options.originalAllocations ?? []).map((row) => ({
          lot_id: BigInt(row.lotId), allocated_qty: new Prisma.Decimal(row.qty), lot: { lot_no: row.lotNo },
        }))),
      groupBy: () => Promise.resolve([]),
      createMany: ({ data }: { data: Row[] }) => {
        allocated.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
    // 세션 없는 실적은 작업자 배분이 없다 — 읽기만 한다.
    production_result_worker_allocation: { findMany: () => Promise.resolve([]) },
    defect_record: {
      // 원본 내역 복사는 원본 id 하나로, 응답의 내역 읽기는 `in` 으로 묻는다 — 응답 쪽은 여기서 보지 않는다.
      findMany: ({ where }: { where: { production_result_id: unknown } }) =>
        Promise.resolve(typeof where.production_result_id === 'bigint' ? (options.originalDefects ?? []) : []),
      createMany: ({ data }: { data: Row[] }) => {
        defectsWritten.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  };

  const prisma = {
    production_result: {
      findUnique: () =>
        Promise.resolve(
          options.missing === true ? null : { work_order_id: original.work_order_id, occurred_at: original.occurred_at },
        ),
    },
    work_order: { findUnique: () => Promise.resolve({ routing_operation: { process_id: 30n } }) },
    defect_code: {
      findMany: ({ where }: { where: { defect_code_id: { in: bigint[] } } }) =>
        Promise.resolve(
          where.defect_code_id.in.map((id) => ({
            defect_code_id: id,
            is_active: true,
            parent_defect_code_id: 1n,
            defect_code_process: [{ defect_code_process_id: 9n }],
          })),
        ),
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const next = jest.fn((...args: unknown[]) => {
    order.push('numbering');
    numbered.push(args);
    return Promise.resolve(CORRECT_NO);
  });

  return {
    service: new ProductionResultCorrectService(prisma, { next } as unknown as NumberingService),
    created,
    updated,
    allocated,
    defectsWritten,
    audits,
    sequenceWheres,
    numbered,
    order,
    next,
  };
}

const body = (overrides: Partial<ProductionResultCorrect> = {}): ProductionResultCorrect => ({
  reasonCode: 'MISCOUNT',
  ...overrides,
});

const context = () => ({ idempotencyKey: 'idem-correct', appUserId: 9 });

function errorsOf(caught: unknown) {
  expect(caught).toBeInstanceOf(ContractException);
  return (caught as ContractException).errors;
}

const ONE_LOT = [{ lotId: 501, lotNo: 'L-501', qty: 10 }];
const TWO_LOTS = [{ lotId: 501, lotNo: 'L-501', qty: 6 }, { lotId: 502, lotNo: 'L-502', qty: 4 }];

describe('생산 실적 정정 (I-7 PR ③)', () => {
  it('정정 — 마감 전 수량 정정은 승인 없이 되고, LOT 이 하나면 양품 차이만큼 그 LOT 배분을 고친다', async () => {
    const harness = stub({ originalAllocations: ONE_LOT });

    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 12 }), context());

    expect(harness.created[0]).toMatchObject({ good_qty: 12, defect_qty: 2 });
    expect(harness.allocated).toEqual([expect.objectContaining({ lot_id: 501n, allocated_qty: 12, uom_id: 3n })]);
  });

  it('정정 — 수량이 같으면 원본 배분을 그대로 옮긴다(LOT 수량은 잎만 세므로 두 번 세지 않는다)', async () => {
    const harness = stub({ originalAllocations: TWO_LOTS });

    await harness.service.correct(ORIGINAL_ID, body({ note: '집계 오기' }), context());

    expect(harness.created[0]).toMatchObject({ correct_reason_code: 'MISCOUNT', remarks: '집계 오기' });
    expect(harness.allocated.map((row) => [row.lot_id, row.allocated_qty])).toEqual([[501n, 6], [502n, 4]]);
  });

  it('정정 — 원본 LOT 이 여럿인데 양품이 바뀌면 LOT 별 수량을 요구한다(배분을 안 보냈으니 양품 칸을 짚는다)', async () => {
    const harness = stub({ originalAllocations: TWO_LOTS });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 8 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'goodQty', code: ERROR_CODE.REQUIRED }]);
    expect(harness.created).toEqual([]);
  });

  it('정정 — lotAllocations 는 원본이 배분한 LOT 안에서만 받는다', async () => {
    const harness = stub({ originalAllocations: ONE_LOT });

    const caught = await harness.service
      .correct(ORIGINAL_ID, body({ goodQty: 8, lotAllocations: [{ lotId: 999, allocatedQty: 8 }] }), context())
      .catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'lotAllocations', code: ERROR_CODE.INVALID }]);
  });

  it('정정 — 마감된 W/O 는 400 STATE_LOCKED 이고 W/O 번호와 할 일을 알린다', async () => {
    const harness = stub({ workOrderStatus: 'CLOSED', originalAllocations: ONE_LOT });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 12 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toEqual([{
      scope: 'screen', code: ERROR_CODE.STATE_LOCKED,
      message: 'W/O WO-0900 는 마감돼 ERP 로 생산입고가 이미 나갔습니다(W/O 진행 상세에서 확인). 실적을 고칠 수 없습니다 — 수량 차이는 재고 조정으로 맞추세요.',
    }]);
    expect(harness.created).toEqual([]);
  });

  it('정정 — 바뀌는 LOT 이 이미 생산입고됐으면 400 STATE_LOCKED 이고 입고 번호와 할 일을 알린다', async () => {
    const harness = stub({ originalAllocations: ONE_LOT, downstream: [{ lot_no: 'L-501', kind: 'RECEIPT', ref_no: 'GR-1' }] });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 12 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toEqual([{
      scope: 'field', field: 'goodQty', code: ERROR_CODE.STATE_LOCKED,
      message: 'LOT L-501 은 이미 생산입고 GR-1 로 창고에 들어갔습니다(LOT 추적에서 확인). 생산입고를 취소한 뒤 정정하세요.',
    }]);
  });

  it('정정 — 누가·언제·전/후·사유를 변경 이력에 남긴다', async () => {
    const harness = stub({ originalAllocations: ONE_LOT });

    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 12, note: '오입력' }), context());

    expect(harness.audits).toEqual([expect.objectContaining({
      target_type_code: 'PRODUCTION_RESULT', target_id: BigInt(ORIGINAL_ID), event_type_code: 'RESULT_CORRECTED',
      reason: 'MISCOUNT · 오입력', performed_by: 9n,
      before_value: expect.objectContaining({ goodQty: 10, lotAllocations: [{ lotId: 501, lotNo: 'L-501', allocatedQty: 10 }] }),
      after_value: expect.objectContaining({ goodQty: 12, lotAllocations: [{ lotId: 501, allocatedQty: 12 }] }),
    })]);
  });

  it('정정 — 사건 칸 열은 원본을 승계한다', async () => {
    const harness = stub({
      original: originalRow({ work_session_id: 41n, equipment_id: 42n, mold_id: 43n, shift_id: 44n, terminal_id: 45n }),
      maxSequence: 4,
    });

    await harness.service.correct(ORIGINAL_ID, body(), context());

    expect(harness.created[0]).toMatchObject({
      corrects_production_result_id: BigInt(ORIGINAL_ID),
      work_order_id: BigInt(WORK_ORDER),
      work_session_id: 41n,
      equipment_id: 42n,
      mold_id: 43n,
      shift_id: 44n,
      terminal_id: 45n,
      uom_id: 3n,
      result_source_code: 'MANUAL',
      occurred_at: OCCURRED_AT,
      worker_id: 55n,
      // 새 전표라 번호·순번·상태·멱등키는 «이 요청»의 것이다.
      production_result_no: CORRECT_NO,
      result_sequence: 5,
      status_code: 'CONFIRMED',
      idempotency_key: 'idem-correct',
      created_by: 9,
    });
    // ⛔ 지연 사유는 사건 칸 열이 아니다 — 승계하지 않는다.
    expect(Object.keys(harness.created[0])).not.toContain('late_entry_reason_code');
    // 채번 기간은 «원본 사건 시각»의 UTC 날짜다 — 오늘로 다시 잡지 않는다.
    expect(harness.numbered[0]).toEqual(['PRODUCTION_RESULT', null, '2026-09-06']);
    // ⭐ 자물쇠는 W/O → 실적 순이다(교착 회피) · 채번은 트랜잭션 «밖»이다.
    expect(harness.order).toEqual(['numbering', 'transaction', 'lock-work-order', 'lock-result']);
    expect(harness.sequenceWheres).toEqual([{ work_order_id: BigInt(WORK_ORDER) }]);
  });

  it('정정 — 원본의 `version_no` 를 안 올린다', async () => {
    const harness = stub();

    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 30 }), context());

    // ⌜원본을 고치지 않는다(G-18)⌝ — 고칠 것이 없으므로 If-Match 도 받지 않는다.
    expect(harness.updated).toEqual([]);
  });

  it('정정 — 정정본을 다시 정정할 수 있다', async () => {
    const harness = stub({ original: originalRow({ corrects_production_result_id: 6900n }) });

    await harness.service.correct(ORIGINAL_ID, body({ note: '재정정' }), context());

    // 체인을 막으려면 「정정본인가」 축을 하나 더 봐야 하는데 계약도 물리도 안 막았고,
    // §5-3 의 잎 규칙이 체인을 이미 옳게 센다.
    expect(harness.created[0]).toMatchObject({ corrects_production_result_id: BigInt(ORIGINAL_ID) });
  });

  it('정정 — 이미 정정된 원본은 다시 정정할 수 없다(형제가 서면 누계가 두 배다 · R-21)', async () => {
    const harness = stub({ correctedCount: 1 });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 7 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.STATE_LOCKED }]);
    expect(harness.created).toEqual([]);
  });

  it('정정 — 다섯 수량을 모두 0 으로 정정할 수 있고 그때 LOT 배분은 없다(잘못 넣은 실적 지우기)', async () => {
    const harness = stub({ original: originalRow({ defect_qty: new Prisma.Decimal(0) }), originalAllocations: [{ lotId: 501, lotNo: 'L-501', qty: 6 }, { lotId: 502, lotNo: 'L-502', qty: 4 }] });

    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 0 }), context());

    expect(harness.created[0]).toMatchObject({ good_qty: 0, defect_qty: 0, hold_qty: 0, scrap_qty: 0, rework_qty: 0 });
    expect(harness.allocated).toEqual([]);
  });

  describe('불량 유형 내역', () => {
    const fieldRecord = (defectCodeId: bigint, qty: number): Row => ({
      defect_record_id: 80n + defectCodeId,
      source_type_code: 'FIELD',
      production_result_id: BigInt(ORIGINAL_ID),
      work_order_id: BigInt(WORK_ORDER),
      defect_code_id: defectCodeId,
      defect_qty: new Prisma.Decimal(qty),
      uom_id: 3n,
      occurrence_process_id: 30n,
      detection_process_id: 30n,
      worker_id: 55n,
      equipment_id: null,
      mold_id: null,
      occurred_at: OCCURRED_AT,
      detected_at: OCCURRED_AT,
      created_by: null,
    });

    it('정정이 불량수량을 그대로 두면 원본의 FIELD 기록을 정정본에 복사한다', async () => {
      const { service, defectsWritten } = stub({ originalDefects: [fieldRecord(4n, 1), fieldRecord(5n, 1)] });

      await service.correct(ORIGINAL_ID, body({ goodQty: 10 }), context());

      expect(defectsWritten.map((row) => [row.defect_code_id, Number(row.defect_qty)])).toEqual([
        [4n, 1],
        [5n, 1],
      ]);
      // 정정본에 붙고, 남긴 사람은 정정한 사람이다.
      expect(defectsWritten[0]).toMatchObject({ source_type_code: 'FIELD', created_by: 9, occurrence_process_id: 30n });
      expect(defectsWritten[0]).not.toHaveProperty('defect_record_id');
    });

    it('불량수량을 바꾸고 defects 가 없으면 내역 없이 수량만 정정한다 — 원본에 유형 기록이 있어도', async () => {
      const { service, defectsWritten, created } = stub({ originalDefects: [fieldRecord(4n, 2)] });

      await service.correct(ORIGINAL_ID, body({ defectQty: 3 }), context());

      expect(created[0]).toMatchObject({ defect_qty: 3 });
      expect(defectsWritten).toEqual([]);
    });

    it('원본에 유형 기록이 없으면 수량만 정정한다', async () => {
      const { service, defectsWritten } = stub();

      await service.correct(ORIGINAL_ID, body({ goodQty: 10 }), context());

      expect(defectsWritten).toEqual([]);
    });

    it('defects 만 실은 정정은 그 합이 불량수량이고 그 내역을 정정본에 남긴다', async () => {
      const { service, defectsWritten, created } = stub({ originalDefects: [fieldRecord(4n, 2)] });

      await service.correct(ORIGINAL_ID, body({ defects: [{ defectCodeId: 6, qty: 1 }, { defectCodeId: 7, qty: 2 }] }), context());

      expect(created[0]).toMatchObject({ defect_qty: 3 });
      expect(defectsWritten.map((row) => row.defect_code_id)).toEqual([6n, 7n]);
    });

    it('수량은 같고 유형 구성만 바꾸는 정정도 된다', async () => {
      const { service, defectsWritten } = stub({ originalDefects: [fieldRecord(4n, 2)] });

      await service.correct(ORIGINAL_ID, body({ defects: [{ defectCodeId: 6, qty: 2 }] }), context());

      expect(defectsWritten.map((row) => row.defect_code_id)).toEqual([6n]);
    });

    it('정정 defects 도 등록과 같은 검사를 받는다 — 불량수량과 합이 다르면 400', async () => {
      const { service, created } = stub();

      const caught = await service
        .correct(ORIGINAL_ID, body({ defectQty: 5, defects: [{ defectCodeId: 6, qty: 1 }] }), context())
        .catch((error: unknown) => error);

      expect(errorsOf(caught)[0]).toMatchObject({ field: 'defects', code: ERROR_CODE.INVALID });
      expect(created).toEqual([]);
    });
  });
});
