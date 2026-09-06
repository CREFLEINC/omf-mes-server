import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues, day } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';

/** 요청 스키마에 `statusCode` 칸이 없어 서버가 정한다. ⛔ 라인 진행은 이 값으로 판정하지
 *  않는다(`x-no-code-key` · A-21 — 값 목록 자체가 없다 · I-3.md §5-4). */
export const DOCUMENT_STATUS = 'REGISTERED';
/** 시드 `LOT_TYPE` 3값 중 자재 입하가 고를 수 있는 하나(I-3.md §5-1). */
export const MATERIAL_LOT_TYPE = 'MATERIAL';

export interface InboundReceiptLineWriteInput {
  /** ⛔ 등록에서는 «무시한다» — 언제나 신규 행이다. 계약이 허용한 칸이라 400 도 아니다(R-7 ④). */
  inboundReceiptLineId?: number;
  purchaseOrderLineId?: number | null;
  asnLineId?: number | null;
  itemId: number;
  receivedQty: number;
  uomId: number;
  packageCount?: number | null;
  supplierLotNo?: string | null;
  supplierLotMissing: boolean;
  substituteLotReasonCode?: string | null;
  manufacturedDate?: string | null;
  expiryDate?: string | null;
}

export interface InboundReceiptCreateInput {
  supplierId: number;
  plantId: number;
  receiptDatetime: string;
  deliveryNoteNo?: string | null;
  vehicleNo?: string | null;
  dockLocationId?: number | null;
  exceptionTypeCode?: string | null;
  exceptionReason?: string | null;
  /** ⛔ 받아서 «버린다» — 담을 칸이 없고 첨부 오퍼레이션이 1차에 안 선다(I-3.md §7-3). */
  deliveryNoteAttachmentId?: number | null;
  /** ⛔ 저장하지 않는다 — 원장을 지나지 않아 실을 표가 없다. 형식만 보고 채번의 기간
   *  축으로만 쓴다(I-3.md §2-5 · 공유계약 C-8). */
  businessDate: string;
  occurredAt: string;
  lines: InboundReceiptLineWriteInput[];
}

/** `@db.Date` 칸 — 값이 있으면 `day` 가 형식까지 보고, 없으면 널이다(등록·치환 공용). */
export function dayOrNull(path: string, value: string | null | undefined): Date | null {
  return value == null ? null : day(path, value);
}

/** 사전부착 라인 — 이 라인만 등록과 같은 트랜잭션에서 LOT 을 얻는다(I-3.md §5-1). */
export function attachesLot(line: InboundReceiptLineWriteInput): boolean {
  return !line.supplierLotMissing;
}

/**
 * 트랜잭션을 열기 «전»의 검증 — 잠근 뒤 400 을 내면 부모 P/O 를 헛되이 붙잡는다.
 * ⛔ `src/trace/lot/lot-rules.ts` 의 날짜 도우미를 가로질러 부르지 않는다(§6-4).
 */
export async function assertWritable(
  prisma: PrismaService,
  input: InboundReceiptCreateInput,
): Promise<void> {
  // 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다.
  if (input.lines.length === 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('lines', ERROR_CODE.LINE_REQUIRED, '입하 라인이 1건 이상이어야 합니다.'),
    ]);
  }

  const errors: ErrorItem[] = [];
  if (Number.isNaN(Date.parse(input.receiptDatetime))) {
    errors.push(field('receiptDatetime', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  // ⛔ 정규식만으로는 `2026-13-39` 가 통과한다 — 저장은 안 되지만 채번의 기간 축으로 들어가
  //    `IR-20261339-0001` 이 `inbound_receipt_no` 에 «영구히» 남는다. 달력에 있는 날인지 함께 본다
  //    (`lot-rules.ts:assertDay` 와 같은 축 · import 는 안 한다 · §6-4).
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
    Number.isNaN(Date.parse(`${input.businessDate}T00:00:00Z`))
  ) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'));
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) {
    errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  // 「`exceptionTypeCode` 가 있으면 필수」(계약).
  if (input.exceptionTypeCode != null && !input.exceptionReason) {
    errors.push(field('exceptionReason', ERROR_CODE.PAIR, '예외 유형과 사유는 짝입니다.'));
  }
  // ⭐ 「P/O 를 고르지 않고 진행할 때 필수」(계약 `InboundReceiptCreate` description) —
  //   무발주 입하에 승인을 걸지 않는 대신 예외 유형·사유 기록이 통제다(R-7 ②).
  if (input.lines.some((line) => line.purchaseOrderLineId == null) && input.exceptionTypeCode == null) {
    errors.push(
      field('exceptionTypeCode', ERROR_CODE.REQUIRED, 'P/O 를 고르지 않은 라인이 있으면 예외 유형이 필요합니다.'),
    );
  }
  assertLines(input.lines, errors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  await assertCodeValues(prisma, [
    {
      field: 'exceptionTypeCode',
      value: input.exceptionTypeCode,
      groupCode: 'INBOUND_RECEIPT_EXCEPTION_TYPE',
    },
    ...input.lines.map((line, index) => ({
      field: `lines.${index}.substituteLotReasonCode`,
      value: line.substituteLotReasonCode,
      groupCode: 'SUBSTITUTE_LOT_REASON',
    })),
  ]);
}

function assertLines(lines: InboundReceiptLineWriteInput[], errors: ErrorItem[]): void {
  const lotNos = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const at = `lines.${index}`;
    // 「`supplierLotMissing` 이 참일 때 필수」(계약).
    if (line.supplierLotMissing && !line.substituteLotReasonCode) {
      errors.push(
        field(`${at}.substituteLotReasonCode`, ERROR_CODE.PAIR, '대체 LOT 사유가 필요합니다.'),
      );
    }
    // 설계 미정 — 문의 028: 계약은 이 조합을 막지 않는다. lot.lot_no NOT NULL 이라 서버가 거절한다.
    // (계약 「부착 라인의 LOT 이 없으면 이후 흐름이 통째로 막힌다」 · §2 2단계 기준 2 「거부하는 쪽」).
    if (attachesLot(line) && !line.supplierLotNo) {
      errors.push(
        field(`${at}.supplierLotNo`, ERROR_CODE.PAIR, '공급사 LOT 번호가 없으면 supplierLotMissing 이 참이어야 합니다.'),
      );
    }
    // ⛔ 안 가르면 `uq_lot(plant_id, lot_no)` P2002 로 트랜잭션이 통째로 죽는다(R-7 ③).
    if (attachesLot(line) && line.supplierLotNo) {
      if (lotNos.has(line.supplierLotNo)) {
        errors.push(field(`${at}.supplierLotNo`, ERROR_CODE.INVALID, '한 요청 안에서 겹칩니다.'));
      }
      lotNos.add(line.supplierLotNo);
    }
    // ⛔ `ck_inbound_expiry` 위반은 알려진 오류가 아니라 500 으로 샌다 — 손으로 앞당긴다.
    if (line.expiryDate && line.manufacturedDate && line.expiryDate < line.manufacturedDate) {
      errors.push(field(`${at}.expiryDate`, ERROR_CODE.INVALID, '제조일보다 앞설 수 없습니다.'));
    }
  }
}
