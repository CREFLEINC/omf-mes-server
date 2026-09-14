import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InboundReceiptCreateInput,
  InboundReceiptLineWriteInput,
  MaterialLotCodeCheck,
  assertAttachedLotCodes,
  assertWritable,
  collectHeaderErrors,
} from './inbound-receipt-rules';

/**
 * 트랜잭션을 열기 «전»의 검증만 본다 — 잠금·채번·LOT 은 서비스 몫이다(PR ②b-2).
 * `assertCodeValues` 가 DB 를 보므로 `code_value` 만 흉내 낸다(고객 확장값도 통과해야 한다).
 */

const ATTACHED_LOT_NO = '040101-00022S|10|260806|100019|0001';

const line = (overrides: Partial<InboundReceiptLineWriteInput> = {}): InboundReceiptLineWriteInput => ({
  purchaseOrderLineId: 101,
  itemId: 40,
  receivedQty: 10,
  uomId: 50,
  supplierLotMissing: false,
  supplierLotNo: ATTACHED_LOT_NO,
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
/** `ATTACHED_LOT_NO` 의 제품코드·공급사코드와 맞춘 마스터 값 — `line().itemId`/`input().supplierId` 대응. */
const ITEM_CODE = '040101-00022S';
const SUPPLIER_CODE = '100019';

function fake(options: { codes?: string[]; itemCode?: string; supplierCode?: string } = {}): PrismaService {
  const known = new Set(options.codes ?? KNOWN);
  return {
    code_value: {
      findMany: async ({ where }: { where: { OR: { code: string; code_group: { group_code: string } }[] } }) =>
        where.OR.filter((check) => known.has(`${check.code_group.group_code} ${check.code}`)).map((check) => ({
          code: check.code,
          code_group: { group_code: check.code_group.group_code },
        })),
    },
    item: { findMany: async () => [{ item_id: 40n, item_code: options.itemCode ?? ITEM_CODE }] },
    partner: { findMany: async () => [{ partner_id: 10n, partner_code: options.supplierCode ?? SUPPLIER_CODE }] },
  } as unknown as PrismaService;
}

describe('입하 등록 검사', () => {
  it('등록 — purchaseOrderLineId 가 빈 라인이 있으면 exceptionTypeCode 가 필수다(계약 문자)', async () => {
    const error = await thrown(() => assertWritable(fake(), input({ lines: [line({ purchaseOrderLineId: null })] })));

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
            line({
              supplierLotMissing: true,
              supplierLotNo: null,
              substituteLotReasonCode: 'NOPE',
            }),
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
    const error = await thrown(() => assertWritable(fake(), input({ lines: [line({ supplierLotNo: null })] })));

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
        input({
          lines: [line({ supplierLotNo: ATTACHED_LOT_NO }), line({ supplierLotNo: ATTACHED_LOT_NO })],
        }),
      ),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.1.supplierLotNo',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — supplierLotMissing=true 와 supplierLotLabelAttached=true 는 400 PAIR 다', async () => {
    const error = await thrown(() =>
      assertWritable(
        fake(),
        input({
          lines: [
            line({
              supplierLotNo: null,
              supplierLotMissing: true,
              supplierLotLabelAttached: true,
              substituteLotReasonCode: 'NO_LABEL',
            }),
          ],
        }),
      ),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.supplierLotLabelAttached',
      code: ERROR_CODE.PAIR,
    });
  });

  it('등록 — 번호가 있으나 라벨 미부착이면 외부 원문 형식을 강제하지 않는다', async () => {
    await expect(
      assertWritable(
        fake(),
        input({
          lines: [
            line({
              supplierLotNo: '납품서-LOT/A-01',
              supplierLotLabelAttached: false,
            }),
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('등록 — 사전부착 LOT 번호가 구분자 5칸 형식이면 통과한다(통보 277)', async () => {
    await expect(assertWritable(fake(), input({ lines: [line({ supplierLotNo: ATTACHED_LOT_NO })] }))).resolves.toBeUndefined();
  });

  it('등록 — 사전부착 LOT 번호의 제품코드가 실 품목과 다르면 400 INVALID다(§2-3 결정 5)', async () => {
    const error = await thrown(() =>
      assertWritable(fake({ itemCode: '다른코드' }), input({ lines: [line({ supplierLotNo: ATTACHED_LOT_NO })] })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.supplierLotNo',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — 사전부착 LOT 번호의 공급사코드가 실 공급사와 다르면 400 INVALID다(§2-3 결정 5)', async () => {
    const error = await thrown(() =>
      assertWritable(fake({ supplierCode: '다른코드' }), input({ lines: [line({ supplierLotNo: ATTACHED_LOT_NO })] })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.supplierLotNo',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — 사전부착 LOT 번호의 수량 칸이 실제 입하 수량과 달라도 통과한다(스냅샷이라 비교하지 않는다 · §2-3 결정 5)', async () => {
    const mismatchedQty = '040101-00022S|999|260806|100019|0001';

    await expect(
      assertWritable(fake(), input({ lines: [line({ receivedQty: 10, supplierLotNo: mismatchedQty })] })),
    ).resolves.toBeUndefined();
  });

  it('등록 — 형식이 깨진 사전부착 LOT 번호는 오류를 한 번만 보고한다(제품코드·공급사 대조를 이중으로 안 한다)', async () => {
    const error = await thrown(() =>
      assertWritable(fake(), input({ lines: [line({ supplierLotNo: '040101-00022S|10|260806|100019' })] })),
    );

    expect((error as ContractException).errors).toHaveLength(1);
  });

  it('등록 — 라벨 미부착 라인은 제품코드·공급사 대조를 건너뛴다', async () => {
    await expect(
      assertWritable(
        fake({ itemCode: '다른코드', supplierCode: '다른코드' }),
        input({
          lines: [line({ supplierLotNo: '납품서-LOT/A-01', supplierLotLabelAttached: false })],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('등록 — 대조 대상 품목·공급사 마스터 행이 없으면 조용히 건너뛴다(「없는 품목」은 다른 결정 사안)', async () => {
    const noMaster = {
      code_value: { findMany: async () => [] },
      item: { findMany: async () => [] },
      partner: { findMany: async () => [] },
    } as unknown as PrismaService;

    await expect(
      assertWritable(noMaster, input({ lines: [line({ supplierLotNo: ATTACHED_LOT_NO })] })),
    ).resolves.toBeUndefined();
  });

  it('등록 — 사전부착 LOT 번호가 옛 34자리 숫자면 400이다(구분자가 없어 칸이 1개다)', async () => {
    const error = await thrown(() =>
      assertWritable(fake(), input({ lines: [line({ supplierLotNo: '0000000400000000102608060000100001' })] })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.supplierLotNo',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — 사전부착 LOT 번호가 4칸이면(구분자 1개 부족) 400이다', async () => {
    const error = await thrown(() =>
      assertWritable(fake(), input({ lines: [line({ supplierLotNo: '040101-00022S|10|260806|100019' })] })),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.supplierLotNo',
      code: ERROR_CODE.INVALID,
    });
  });

  it('assertLines — 공유 집합을 넘기면 호출을 넘어 겹침을 본다', () => {
    const errors: ErrorItem[] = [];
    const lotNos = new Set<string>();

    collectHeaderErrors('normal.', input(), errors, lotNos);
    collectHeaderErrors('excess.', input(), errors, lotNos);

    expect(errors).toEqual([
      expect.objectContaining({
        field: 'excess.lines.0.supplierLotNo',
        code: ERROR_CODE.INVALID,
      }),
    ]);
  });
});

describe('assertAttachedLotCodes', () => {
  const check = (overrides: Partial<MaterialLotCodeCheck> = {}): MaterialLotCodeCheck => ({
    at: 'lines.0.supplierLotNo',
    itemId: 40,
    itemCode: ITEM_CODE,
    supplierId: 10,
    supplierCode: SUPPLIER_CODE,
    ...overrides,
  });

  it('대조 대상이 없으면 조회 없이 빈 배열을 돌려준다', async () => {
    const blowsUp = {
      item: { findMany: async () => { throw new Error('불러선 안 된다'); } },
      partner: { findMany: async () => { throw new Error('불러선 안 된다'); } },
    } as unknown as PrismaService;

    await expect(assertAttachedLotCodes(blowsUp, [])).resolves.toEqual([]);
  });

  it('제품코드·공급사코드가 모두 일치하면 빈 배열을 돌려준다', async () => {
    await expect(assertAttachedLotCodes(fake(), [check()])).resolves.toEqual([]);
  });

  it('제품코드가 다르면 해당 칸을 짚는 INVALID 를 돌려준다', async () => {
    const errors = await assertAttachedLotCodes(fake(), [check({ itemCode: '다른코드' })]);

    expect(errors).toEqual([
      expect.objectContaining({ field: 'lines.0.supplierLotNo', code: ERROR_CODE.INVALID }),
    ]);
  });

  it('공급사코드가 다르면 해당 칸을 짚는 INVALID 를 돌려준다', async () => {
    const errors = await assertAttachedLotCodes(fake(), [check({ supplierCode: '다른코드' })]);

    expect(errors).toEqual([
      expect.objectContaining({ field: 'lines.0.supplierLotNo', code: ERROR_CODE.INVALID }),
    ]);
  });

  it('마스터 행이 없으면 조용히 건너뛴다', async () => {
    const noMaster = {
      item: { findMany: async () => [] },
      partner: { findMany: async () => [] },
    } as unknown as PrismaService;

    await expect(assertAttachedLotCodes(noMaster, [check()])).resolves.toEqual([]);
  });
});

const thrown = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: unknown) => error,
  );
