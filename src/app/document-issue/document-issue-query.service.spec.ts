import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import {
  DocumentIssueQueryService,
  documentIssueWhere,
} from './document-issue-query.service';
import {
  DocumentIssueRow,
  ReasonLookup,
  documentIssueView,
} from './document-issue-view';
import { TargetLookup, targetKey } from './document-issue-target-lookup';

function row(overrides: Partial<DocumentIssueRow> = {}): DocumentIssueRow {
  return {
    document_issue_log_id: 101n,
    document_type_code: 'MATERIAL_LOT_LABEL',
    target_type_code: 'LOT',
    target_id: 201n,
    lot_id: 201n,
    issue_seq: 2,
    reissue_reason_code: 'PRINT_FAILURE',
    issued_by: 301n,
    issued_at: new Date('2026-09-08T01:02:03.456Z'),
    terminal_id: 401n,
    printer_name: 'LABEL-A',
    remarks: '재발행',
    print_outcome_code: 'FAILED',
    print_failure_reason: '용지 없음',
    print_reported_at: new Date('2026-09-08T01:03:00Z'),
    issued_worker_id: 501n,
    print_reported_worker_id: 502n,
    print_reported_by: 302n,
    app_user: { user_name: '발행 계정' },
    lot: { lot_no: 'LOT-201' },
    ...overrides,
  } as DocumentIssueRow;
}

describe('발행 이력 조회 (I-27 P1)', () => {
  it.each([
    ['목록', (service: DocumentIssueQueryService) => service.list({})],
    ['상세', (service: DocumentIssueQueryService) => service.get(101)],
  ])(
    '%s 조회는 대상 이름까지 RepeatableRead 한 snapshot에서 읽는다',
    async (_name, act) => {
      const transaction = jest.fn().mockResolvedValue({});
      const service = new DocumentIssueQueryService({
        $transaction: transaction,
      } as never);
      await act(service);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    },
  );

  it('아홉 필터를 AND로 만들고 기간은 반열림 마이크로초 경계다', () => {
    expect(
      documentIssueWhere({
        documentTypeCode: 'MATERIAL_LOT_LABEL',
        targetTypeCode: 'LOT',
        targetId: 201,
        lotId: 201,
        issuedFrom: '2026-09-08T00:00:00.0000001Z',
        issuedTo: '2026-09-09T00:00:00.9999991Z',
        printOutcome: 'FAILED',
        page: 2,
        size: 10,
      }),
    ).toEqual({
      document_type_code: 'MATERIAL_LOT_LABEL',
      target_type_code: 'LOT',
      target_id: 201n,
      lot_id: 201n,
      print_outcome_code: 'FAILED',
      issued_at: {
        gte: '2026-09-08T00:00:00.000001Z',
        lt: '2026-09-09T00:00:01.000000Z',
      },
    });
  });

  it.each([
    [{ targetTypeCode: 'LOT' as const }, 'targetId'],
    [{ targetId: 201 }, 'targetTypeCode'],
  ])(
    'target 쌍 중 하나만 주면 빠진 %s가 아니라 PAIR다',
    async (query, field) => {
      const service = new DocumentIssueQueryService({} as never);
      try {
        await service.list(query);
        throw new Error('예외가 필요합니다.');
      } catch (error) {
        expect(error).toBeInstanceOf(ContractException);
        expect((error as ContractException).errors).toEqual([
          expect.objectContaining({ field, code: 'PAIR' }),
        ]);
      }
    },
  );

  it.each([
    [
      { targetTypeCode: 'LOT' as const, targetId: Number.MAX_SAFE_INTEGER + 1 },
      'targetId',
    ],
    [{ lotId: Number.MAX_SAFE_INTEGER + 1 }, 'lotId'],
    [{ page: Number.MAX_SAFE_INTEGER, size: 200 }, 'page'],
  ])('안전 정수 범위 밖 query %j는 %s RANGE다', async (query, field) => {
    const service = new DocumentIssueQueryService({} as never);
    await expect(service.list(query)).rejects.toMatchObject({
      errors: [expect.objectContaining({ field, code: 'RANGE' })],
    });
  });

  it('저장 행의 발행 계정·작업자와 target 이름·화면·비활성 과거 사유명을 계약 모양으로 낸다', () => {
    const targets: TargetLookup = new Map([
      [targetKey('LOT', 201n), { displayName: 'LOT-201', screenId: 'P-02-07' }],
    ]);
    const reasons: ReasonLookup = new Map([['PRINT_FAILURE', '인쇄 실패']]);
    expect(documentIssueView(row(), targets, reasons)).toEqual({
      documentIssueLogId: 101,
      documentTypeCode: 'MATERIAL_LOT_LABEL',
      target: {
        targetTypeCode: 'LOT',
        targetId: 201,
        displayName: 'LOT-201',
        screenId: 'P-02-07',
      },
      lotId: 201,
      lotNo: 'LOT-201',
      issueSeq: 2,
      reissueReasonCode: 'PRINT_FAILURE',
      reissueReasonName: '인쇄 실패',
      issuedBy: 301,
      issuedWorkerId: 501,
      issuedByName: '발행 계정',
      issuedAt: '2026-09-08T01:02:03.456Z',
      terminalId: 401,
      printerName: 'LABEL-A',
      printOutcome: 'FAILED',
      remarks: '재발행',
    });
  });

  it('삭제된 대상은 TYPE #id fallback이고 screenId를 생략한다', () => {
    const view = documentIssueView(
      row({
        target_type_code: 'MOLD',
        target_id: 909n,
        lot_id: null,
        lot: null,
      }),
      new Map(),
      new Map([['PRINT_FAILURE', '인쇄 실패']]),
    );
    expect(view.target).toEqual({
      targetTypeCode: 'MOLD',
      targetId: 909,
      displayName: 'MOLD #909',
    });
    expect(view.lotId).toBeNull();
    expect(view.lotNo).toBeNull();
  });

  it.each([
    [{ print_outcome_code: null }, 'printOutcome'],
    [{ print_outcome_code: 'UNKNOWN' }, 'printOutcome'],
    [{ document_type_code: 'UNKNOWN' }, 'documentTypeCode'],
    [{ target_type_code: 'UNKNOWN' }, 'targetTypeCode'],
    [
      { document_issue_log_id: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      'documentIssueLogId',
    ],
    [{ target_id: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'targetId'],
    [{ lot_id: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'lotId'],
    [{ issued_by: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'issuedBy'],
    [{ terminal_id: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'terminalId'],
    [{ issue_seq: 0 }, 'issueSeq'],
    [{ reissue_reason_code: 'R'.repeat(41) }, 'reissueReasonCode'],
    [{ printer_name: 'P'.repeat(101) }, 'printerName'],
    [
      { app_user: { user_name: 'U'.repeat(201) } } as Partial<DocumentIssueRow>,
      'issuedByName',
    ],
    [{ lot: { lot_no: 'L'.repeat(61) } } as Partial<DocumentIssueRow>, 'lotNo'],
  ])(
    '저장 required/범위 결손 %s는 조용히 보정하지 않고 Error 500 원인이다',
    (overrides, field) => {
      expect(() =>
        documentIssueView(row(overrides), new Map(), new Map()),
      ).toThrow(field);
    },
  );

  it.each([
    [
      'displayName',
      new Map([
        [
          targetKey('LOT', 201n),
          { displayName: 'D'.repeat(201), screenId: 'P-02-07' },
        ],
      ]),
      new Map([['PRINT_FAILURE', '인쇄 실패']]),
    ],
    [
      'reissueReasonName',
      new Map([
        [
          targetKey('LOT', 201n),
          { displayName: 'LOT-201', screenId: 'P-02-07' },
        ],
      ]),
      new Map([['PRINT_FAILURE', 'R'.repeat(201)]]),
    ],
  ])('%s 저장 길이 결손을 조용히 자르지 않는다', (field, targets, reasons) => {
    expect(() => documentIssueView(row(), targets, reasons)).toThrow(field);
  });

  it('lotNo 계약 상한 60자는 그대로 허용한다', () => {
    expect(
      documentIssueView(
        row({ lot: { lot_no: 'L'.repeat(60) } } as Partial<DocumentIssueRow>),
        new Map(),
        new Map(),
      ).lotNo,
    ).toHaveLength(60);
  });
});
