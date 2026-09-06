import { Prisma } from '@prisma/client';

import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { CancelEligibility, CancelEligibilityService } from './cancel-eligibility.service';
import { CancelableDocumentType, DocumentCancelService } from './document-cancel.service';
import { DocumentCancelExecuteService } from './document-cancel-execute.service';

const DOC_ID = 11n;
const USER = 7;
const VERSION = 3;
const REASON = '초과 입하분 오등록 — 취소 요청';
const REVERSAL_NO = 'GR-20260504-0001-R';

type Args = Record<string, unknown>;

interface LedgerRow {
  inventory_transaction_id: bigint;
  business_date: Date;
}

interface Seed {
  /** 잠근 대상 행. `undefined` 면 없는 문서다(404). */
  locked?: { status_code: string; version_no: number };
  /** `evaluate()` 가 낼 판정. 기본은 후속 0. */
  verdict?: Partial<CancelEligibility>;
  /** `assertApproved` 가 볼 요청들. 빈 배열이면 0건 — 코어가 «통과»시킨다(R-8). */
  approvals?: { status_code: string }[];
  /** `(source_document_*)` 로 걸리는 원 원장. */
  ledger?: LedgerRow[];
  /** 입하 라인 — 발주 라인 귀속과 수취 수량. */
  inboundLines?: { purchase_order_line_id: bigint | null; received_qty: Prisma.Decimal }[];
  /** 되돌린 «뒤»의 발주 라인 수취 누계. */
  afterQty?: Prisma.Decimal[];
}

const decimal = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * 트랜잭션 하나를 흉내낸다 — 어느 표를 어떤 `where`·`data` 로 «썼는지»와 무엇을 «안 썼는지»가
 * 이 스위트의 목이다. 상태기계·승인 코어는 «진짜»를 쓴다: 이 경로의 정본 가드가 그 둘이라
 * 대역으로 두면 아무것도 안 본다(R-8).
 */
function fake(seed: Seed = {}) {
  const args: Record<string, Args[]> = {};
  const rec =
    <T>(name: string, result: () => T) =>
    async (a?: Args) => {
      (args[name] ??= []).push(a ?? {});
      return result();
    };
  const writable = (name: string) => ({
    updateMany: rec(`${name}.updateMany`, () => ({ count: 1 })),
    update: rec(`${name}.update`, () => ({})),
    updateManyAndReturn: rec(`${name}.updateManyAndReturn`, () => []),
    create: rec(`${name}.create`, () => ({})),
    deleteMany: rec(`${name}.deleteMany`, () => ({ count: 0 })),
  });
  const poLines = seed.afterQty ?? [];
  let poRead = 0;
  const tx = {
    inbound_receipt: writable('inbound_receipt'),
    goods_receipt: writable('goods_receipt'),
    goods_issue: writable('goods_issue'),
    putaway_task: writable('putaway_task'),
    lot: writable('lot'),
    document_cancellation: {
      create: rec('document_cancellation.create', () => ({ document_cancellation_id: 1n })),
    },
    approval_request: {
      findMany: rec('approval_request.findMany', () => seed.approvals ?? [{ status_code: 'APPROVED' }]),
      findFirst: rec('approval_request.findFirst', () => ({ reason: REASON })),
    },
    inventory_transaction: {
      findMany: rec('inventory_transaction.findMany', () => seed.ledger ?? []),
    },
    inbound_receipt_line: {
      ...writable('inbound_receipt_line'),
      findMany: rec('inbound_receipt_line.findMany', () => seed.inboundLines ?? []),
    },
    purchase_order_line: {
      update: rec('purchase_order_line.update', () => ({})),
      // 첫 호출은 부모 매핑(잠글 id), 둘째는 잠근 뒤 하한을 볼 되읽기다.
      findMany: rec('purchase_order_line.findMany', () => {
        poRead += 1;
        return poRead === 1
          ? [{ purchase_order_id: 42n }, { purchase_order_id: 7n }]
          : poLines.map((received_qty) => ({ purchase_order_line_id: 1n, received_qty }));
      }),
    },
    // Prisma 태그드 템플릿 — 잠금 문장은 유형마다 리터럴이라 값은 안 보고 잠근 행만 돌려준다.
    $queryRaw: (...parts: unknown[]) => {
      (args.$queryRaw ??= []).push({ sql: String((parts[0] as string[])?.join('?')) });
      return Promise.resolve(seed.locked === undefined ? [] : [seed.locked]);
    },
  };

  const prisma = {
    $transaction: <T>(work: (client: unknown) => Promise<T>) => work(tx),
  } as unknown as PrismaService;
  const evaluate = jest.fn(
    async (): Promise<CancelEligibility> => ({
      successorCount: 0,
      successors: [],
      cancellable: true,
      ...seed.verdict,
    }),
  );
  const reverse = jest.fn(async (_tx: unknown, _input: Args) => ({
    inventoryTransactionId: 900n,
    transactionNo: REVERSAL_NO,
    businessDate: '2026-05-04',
    alreadyReversed: false,
  }));
  const documentState = new DocumentStateService();
  const service = new DocumentCancelExecuteService(
    prisma,
    // 잠금·상태 쓰기 두 문장은 요청 서비스의 «진짜»를 쓴다 — 표·칸 이름이 그 안에 있다.
    new DocumentCancelService(
      prisma,
      new ApprovalService(documentState),
      { next: async () => 'AP-1' } as never,
      documentState,
      { evaluate: async () => ({}) } as never,
    ),
    new ApprovalService(documentState),
    documentState,
    { evaluate } as unknown as CancelEligibilityService,
    { reverse } as unknown as InventoryPostingService,
  );
  const at = (name: string, index = 0) => args[name]?.[index];
  return { service, args, at, evaluate, reverse };
}

const requested = { status_code: 'CANCEL_REQUESTED', version_no: VERSION };

function cancel(
  service: DocumentCancelExecuteService,
  typeCode: CancelableDocumentType = 'GOODS_RECEIPT',
) {
  return service.cancel(typeCode, DOC_ID, VERSION, USER);
}

function ledgerRow(id: bigint): LedgerRow {
  return { inventory_transaction_id: id, business_date: new Date('2026-05-04T00:00:00.000Z') };
}

describe('DocumentCancelExecuteService', () => {
  it('실행 — 승인 전이면 400 이다(assertApproved 를 후속 재판정보다 먼저 부른다)', async () => {
    const { service, evaluate } = fake({
      locked: requested,
      approvals: [{ status_code: 'PENDING' }],
    });

    await expect(cancel(service)).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ code: 'APPROVAL_IN_PROGRESS' }] },
    });
    // ⭐ 승인 없이 부른 호출에 후속 사유를 알려 주지 않는다 — 재판정에 닿기도 전이다(§6-3).
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('실행 — 승인 요청 0건이면 assertApproved 가 통과하므로 상태 자물쇠가 정본 가드다', async () => {
    const { service, args } = fake({
      locked: { status_code: 'POSTED', version_no: VERSION },
      approvals: [],
    });

    // 요청이 0건이면 승인 코어는 «통과»시킨다(실측) — 막는 것은 `document-cancel` 의 from 뿐이다.
    await expect(cancel(service)).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ code: 'STATE_LOCKED' }] },
    });
    expect(args['approval_request.findMany']).toBeUndefined();
    expect(args['document_cancellation.create']).toBeUndefined();
  });

  it('실행 — 후속 재판정에 걸리면 400 SUCCESSOR_EXISTS 이고 아무 흔적도 안 남긴다(J-8)', async () => {
    const { service, args } = fake({ locked: requested, verdict: { successorCount: 2 } });

    await expect(cancel(service)).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ code: 'SUCCESSOR_EXISTS' }] },
    });
    // 승인도 문서 상태도 그대로다 — 계약 「승인은 그대로 유효하다」(J-8).
    expect(args['document_cancellation.create']).toBeUndefined();
    expect(args['goods_receipt.updateMany']).toBeUndefined();
  });

  it('실행 — document_cancellation 의 previous_status_code 는 취소 직전 상태다', async () => {
    const { service, at } = fake({ locked: requested, ledger: [ledgerRow(1n)] });

    await cancel(service);

    const data = at('document_cancellation.create')?.data as Args;
    expect(data).toMatchObject({
      document_type_code: 'GOODS_RECEIPT',
      document_id: DOC_ID,
      // ⛔ CANCEL_REQUESTED 다 — 「취소 직전」이지 「전기 여부」가 아니다.
      previous_status_code: 'CANCEL_REQUESTED',
      cancelled_by: BigInt(USER),
    });
    expect(at('goods_receipt.updateMany')).toEqual({
      where: { goods_receipt_id: DOC_ID, version_no: VERSION },
      data: { status_code: 'CANCELLED', version_no: { increment: 1 } },
    });
  });

  it('실행 — reason_code 를 안 채우고 reason_detail 은 승인 요청의 사유 원문이다(R-1)', async () => {
    const { service, at } = fake({ locked: requested });

    await cancel(service, 'GOODS_ISSUE');

    const data = at('document_cancellation.create')?.data as Args;
    // 계약이 사유 «코드»를 안 보내고 물류 취소 사유 코드 그룹도 없다 — 선행 마이그가 NOT NULL 을
    // 풀었다. 상수를 박으면 나중에 축이 설 때 상수 행과 진짜 행이 섞인다(R-1).
    expect(data).not.toHaveProperty('reason_code');
    expect(data.reason_detail).toBe(REASON);
    // 사유의 출처는 다형 축이다 — 대상 표의 approval_request_id FK 가 아니다(§2-5).
    expect(at('approval_request.findFirst')?.where).toMatchObject({
      target_type_code: 'GOODS_ISSUE',
      target_id: DOC_ID,
      approval_type_code: 'GOODS_ISSUE_CANCEL',
      status_code: 'APPROVED',
    });
  });

  it('실행 — 원 원장이 있으면 reverse() 를 부르고 reversed:true 로 번호·영업일 2칸을 낸다', async () => {
    const { service, reverse, at } = fake({ locked: requested, ledger: [ledgerRow(77n)] });

    // ⭐ I-5.md §6-3 의 「previous === POSTED 면 역처리」는 못 쓴다 — :cancel 이 언제나
    //    CANCEL_REQUESTED 를 보므로 그 조건은 영원히 거짓이다. 원장 유무가 가른다(§6-4).
    const result = await cancel(service);

    expect(reverse).toHaveBeenCalledTimes(1);
    expect(reverse.mock.calls[0][1]).toMatchObject({
      inventoryTransactionId: 77n,
      // ⛔ 원 트랜잭션의 영업일이다 — :cancel 이 businessDate 를 안 받는다(계약 · C-8).
      businessDate: '2026-05-04',
      createdBy: USER,
    });
    expect(result).toMatchObject({
      reversed: true,
      reversalTransactionNo: REVERSAL_NO,
      reversalBusinessDate: '2026-05-04',
    });
    // 역행 자신은 원 행의 source_document_* 를 물려받는다 — 조회에서 빼지 않으면 다시 되돌린다.
    expect(at('inventory_transaction.findMany')?.where).toMatchObject({
      source_document_type_code: 'GOODS_RECEIPT',
      source_document_id: DOC_ID,
      reversal_of_transaction_id: null,
    });
  });

  it('실행 — 전기 전이면 원장을 안 만들고 reversed:false 다(두 nullable 칸은 키 생략)', async () => {
    const { service, reverse } = fake({ locked: requested });

    const result = await cancel(service);

    expect(reverse).not.toHaveBeenCalled();
    expect(result).toEqual({
      documentTypeCode: 'GOODS_RECEIPT',
      documentId: Number(DOC_ID),
      statusCode: 'CANCELLED',
      reversed: false,
    });
    // ⛔ 널을 내리지 않는다 — 「값 없음」과 「키 없음」이 계약에서 뜻이 갈린다(plan.md §5 규칙 7).
    expect(result).not.toHaveProperty('reversalTransactionNo');
    expect(result).not.toHaveProperty('reversalBusinessDate');
  });

  it('실행 — 원 원장이 2행 이상이면 던진다(첫 행을 조용히 고르지 않는다)', async () => {
    const { service } = fake({ locked: requested, ledger: [ledgerRow(1n), ledgerRow(2n)] });

    // 클라이언트가 고칠 수 있는 것이 아니라 400 이 아니다 — 평범한 Error(500)다(§6-4).
    await expect(cancel(service)).rejects.toThrow(/한 문서에 원장이 2 행이다/);
  });

  it('어댑터 — 입하 취소는 부모 P/O 를 id 오름차순으로 잠그고 received_qty 를 되돌린다', async () => {
    const { service, args, at } = fake({
      locked: requested,
      inboundLines: [
        { purchase_order_line_id: 5n, received_qty: decimal(10) },
        { purchase_order_line_id: null, received_qty: decimal(3) },
      ],
      afterQty: [decimal(0)],
    });

    const result = await cancel(service, 'INBOUND_RECEIPT');

    // 입하는 전기 경로가 없어 reversed 가 언제나 거짓이다(plan-api.md S02).
    expect(result.reversed).toBe(false);
    expect(args['inventory_transaction.findMany']).toBeUndefined();
    // 잠금은 대상 행 + 부모 P/O 두 문장이고 둘째가 오름차순 FOR UPDATE 다.
    expect(String((args.$queryRaw ?? [])[1]?.sql)).toMatch(
      /purchase_order[\s\S]*ORDER BY purchase_order_id[\s\S]*FOR UPDATE/,
    );
    // 귀속 없는 라인은 되돌릴 부모가 없다 — 한 줄만 내린다.
    expect(args['purchase_order_line.update']).toHaveLength(1);
    expect(at('purchase_order_line.update')).toEqual({
      where: { purchase_order_line_id: 5n },
      data: { received_qty: { decrement: decimal(10) } },
    });
  });

  it('어댑터 — 입하 취소가 수취 누계를 음수로 만들면 400 RANGE 다(Decimal 비교)', async () => {
    const { service } = fake({
      locked: requested,
      inboundLines: [{ purchase_order_line_id: 5n, received_qty: decimal(10) }],
      // 0.000001 이라도 음수면 막는다 — Number() 로 접으면 이 경계가 흔들린다.
      afterQty: [decimal(-0.000001)],
    });

    await expect(cancel(service, 'INBOUND_RECEIPT')).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ code: 'RANGE' }] },
    });
  });

  it('어댑터 — 입하 취소는 lot_id 와 LOT 을 손대지 않는다(I-3 R-12 ⓒ)', async () => {
    const { service, args } = fake({
      locked: requested,
      inboundLines: [{ purchase_order_line_id: 5n, received_qty: decimal(10) }],
      afterQty: [decimal(0)],
    });

    await cancel(service, 'INBOUND_RECEIPT');

    // 쓰인 LOT 은 후속 판정이 먼저 막는다 — 여기 닿는 것은 안 쓰인 LOT 뿐이고, 끊으면 「어느
    // LOT 이 이 입하에서 났나」가 지워진다(B-3 이력 불변).
    expect(args['inbound_receipt_line.update']).toBeUndefined();
    expect(args['inbound_receipt_line.updateMany']).toBeUndefined();
    expect(args['lot.update']).toBeUndefined();
    expect(args['lot.updateMany']).toBeUndefined();
  });

  it('어댑터 — 출고 취소는 goods_issue 의 취소 3칸과 approval_request_id 를 안 건드린다', async () => {
    const { service, args, at } = fake({ locked: requested, ledger: [ledgerRow(1n)] });

    await cancel(service, 'GOODS_ISSUE');

    // 취소 흔적의 정본은 app.document_cancellation 한 표다 — 계약 GoodsIssue 가 3칸을 안 읽는다.
    expect(args['goods_issue.update']).toBeUndefined();
    expect(Object.keys(at('goods_issue.updateMany')?.data as Args)).toEqual([
      'status_code',
      'version_no',
    ]);
  });

  it('어댑터 — 입고 취소는 putaway_task 를 손대지 않는다', async () => {
    const { service, args } = fake({ locked: requested, ledger: [ledgerRow(1n)] });

    await cancel(service, 'GOODS_RECEIPT');

    // 계약 DocumentSuccessor 5값에 PUTAWAY_TASK 가 없어 후속으로 셀 수도 응답에 실을 수도 없다.
    // ⚠ 취소된 입고의 적치 지시가 남는다 — 「알려둘 것」.
    expect(args['putaway_task.update']).toBeUndefined();
    expect(args['putaway_task.updateMany']).toBeUndefined();
    expect(args['putaway_task.deleteMany']).toBeUndefined();
  });
});
