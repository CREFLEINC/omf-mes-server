import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InboundReceiptCreateInput,
  InboundReceiptLineWriteInput,
  assertWritable,
} from './inbound-receipt-rules';

/**
 * 트랜잭션을 열기 «전»의 검증만 본다 — 잠금·채번·LOT 은 서비스 몫이다(PR ②b-2).
 * `assertCodeValues` 가 DB 를 보므로 `code_value` 만 흉내 낸다(고객 확장값도 통과해야 한다).
 */

const line = (overrides: Partial<InboundReceiptLineWriteInput> = {}): InboundReceiptLineWriteInput => ({
  purchaseOrderLineId: 101,
  itemId: 40,
  receivedQty: 10,
  uomId: 50,
  supplierLotMissing: false,
  supplierLotNo: 'SL-0001',
  ...overrides,
});

const input = (overrides: Partial<InboundReceiptCreateInput> = {}): InboundReceiptCreateInput => ({
  supplierId: 10,
  plantId: 30,
  receiptDatetime: '2026-08-06T09:12:00+09:00',
  businessDate: '2026-08-06',
  occurredAt: '2026-08-06T09:12:00+09:00',
  lines: [line()],
  ...overrides,
});

const KNOWN = ['INBOUND_RECEIPT_EXCEPTION_TYPE CUSTOMER_SUPPLY', 'SUBSTITUTE_LOT_REASON NO_LABEL'];

function fake(codes: string[] = KNOWN): PrismaService {
  const known = new Set(codes);
  return {
    code_value: {
      findMany: async ({
        where,
      }: {
        where: { OR: { code: string; code_group: { group_code: string } }[] };
      }) =>
        where.OR.filter((check) => known.has(`${check.code_group.group_code} ${check.code}`)).map(
          (check) => ({ code: check.code, code_group: { group_code: check.code_group.group_code } }),
        ),
    },
  } as unknown as PrismaService;
}

describe('입하 등록 검사', () => {
  it('등록 — purchaseOrderLineId 가 빈 라인이 있으면 exceptionTypeCode 가 필수다(계약 문자)', async () => {
    const error = await thrown(() =>
      assertWritable(fake(), input({ lines: [line({ purchaseOrderLineId: null })] })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'exceptionTypeCode',
      code: ERROR_CODE.REQUIRED,
    });
  });

  it('등록 — exceptionTypeCode 가 code_value 에 없으면 400 이다', async () => {
    const error = await thrown(() =>
      assertWritable(fake(), input({ exceptionTypeCode: 'NOT_A_CODE', exceptionReason: '사유' })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'exceptionTypeCode',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — substituteLotReasonCode 가 code_value 에 없으면 400 이다', async () => {
    const error = await thrown(() =>
      assertWritable(
        fake(),
        input({
          lines: [
            line({ supplierLotMissing: true, supplierLotNo: null, substituteLotReasonCode: 'NOPE' }),
          ],
        }),
      ),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.substituteLotReasonCode',
      code: ERROR_CODE.INVALID,
    });
  });

  // 설계 미정 — 문의 028(계약이 막지 않는 조합을 서버가 거절한다 · README §2 3단계 흔적).
  it('등록 — supplierLotMissing=false 인데 supplierLotNo 가 비면 400 PAIR 다(lot_no 가 NOT NULL 이라 LOT 을 못 만든다 · 문의 028)', async () => {
    const error = await thrown(() =>
      assertWritable(fake(), input({ lines: [line({ supplierLotNo: null })] })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.supplierLotNo',
      code: ERROR_CODE.PAIR,
    });
  });

  it('등록 — businessDate 가 달력에 없는 날이면 400 이다(정규식만으로는 채번에 새는 날이 남는다)', async () => {
    const error = await thrown(() => assertWritable(fake(), input({ businessDate: '2026-13-39' })));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'businessDate',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — 한 요청 안 supplierLotNo 가 겹치면 400 이다(P2002 로 새지 않는다)', async () => {
    const error = await thrown(() =>
      assertWritable(
        fake(),
        input({ lines: [line({ supplierLotNo: 'SL-같음' }), line({ supplierLotNo: 'SL-같음' })] }),
      ),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.1.supplierLotNo',
      code: ERROR_CODE.INVALID,
    });
  });
});

const thrown = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: unknown) => error,
  );
