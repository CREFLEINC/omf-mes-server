import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { CodeCheck, assertCodeValues, day } from '../../common/master';
// ⛔ §6-4 — 다른 슬라이스(`src/trace/`)를 가로질러 부르지 않는다. `core/lot` 은 공용(모든
//    도메인이 가져다 쓰는 코어)이라 그 규칙 밖이다 — `recycle-entry.service.ts` 도 같은 자리에서
//    `core/lot` 을 가져온다.
import { parseMaterialLotNo } from '../../core/lot';
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
  supplierLotLabelAttached?: boolean;
  substituteLotReasonCode?: string | null;
  manufacturedDate?: string | null;
  expiryDate?: string | null;
}

/** 헤더 한 벌 — 등록 본문과 `:split` 의 한쪽(계약 `InboundReceiptSplitPart`)이 함께 쓴다.
 *  ⛔ `vehicleNo` 는 `SplitPart` 에 «없다» — 선택 칸이라 분리가 그냥 안 싣는다(R-11 ⓚ). */
export interface InboundReceiptHeaderWriteInput {
  supplierId: number;
  plantId: number;
  receiptDatetime: string;
  deliveryNoteNo?: string | null;
  vehicleNo?: string | null;
  dockLocationId?: number | null;
  exceptionTypeCode?: string | null;
  exceptionReason?: string | null;
  remarks?: string | null;
  lines: InboundReceiptLineWriteInput[];
}

export interface InboundReceiptCreateInput extends InboundReceiptHeaderWriteInput {
  /** ⛔ 받아서 «버린다» — 담을 칸이 없고 첨부 오퍼레이션이 1차에 안 선다(I-3.md §7-3). */
  deliveryNoteAttachmentId?: number | null;
  /** ⛔ 저장하지 않는다 — 원장을 지나지 않아 실을 표가 없다. 형식만 보고 채번의 기간
   *  축으로만 쓴다(I-3.md §2-5 · 공유계약 C-8). */
  businessDate: string;
  occurredAt: string;
}

/** `@db.Date` 칸 — 값이 있으면 `day` 가 형식까지 보고, 없으면 널이다(등록·치환 공용). */
export function dayOrNull(path: string, value: string | null | undefined): Date | null {
  return value == null ? null : day(path, value);
}

/** 사전부착 라인 — 이 라인만 등록과 같은 트랜잭션에서 LOT 을 얻는다(I-3.md §5-1). */
export function attachesLot(line: InboundReceiptLineWriteInput): boolean {
  return supplierLotLabelAttached(line);
}

/** 예전 클라이언트는 부착 여부를 보내지 않았다. 기존 의미를 공급사 LOT 유무로 복원한다. */
export function supplierLotLabelAttached(line: InboundReceiptLineWriteInput): boolean {
  return line.supplierLotLabelAttached ?? !line.supplierLotMissing;
}

/** 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다.
 *  `at` 은 계약 필드 경로다(등록 `lines` · 분리 `normal.lines`). */
export function lineRequired(at: string): ErrorItem {
  return field(at, ERROR_CODE.LINE_REQUIRED, '입하 라인이 1건 이상이어야 합니다.');
}

/** 사전부착 LOT 번호에서 파싱된 제품코드·공급사코드를 실 라인/공급사와 대조할 자리 한 건. */
export interface MaterialLotCodeCheck {
  at: string;
  itemId: number;
  itemCode: string;
  supplierId: number;
  supplierCode: string;
}

/**
 * 헤더 한 벌의 형식·짝·라인 검증. `at` 은 계약 필드 경로의 앞머리다(등록 `''` · 분리
 * `'normal.'`·`'excess.'`). 돌려주는 것은 DB 를 봐야 하는 코드값 검사 목록이다.
 *
 * ⛔ 「P/O 를 고르지 않고 진행할 때 `exceptionTypeCode` 필수」는 여기 «없다» — 계약이 그
 * 문장을 `InboundReceiptCreate` 에만 적었고 `SplitPart` 초과분은 정의상 무발주다(R-7 ②).
 */
export function collectHeaderErrors(
  at: string,
  header: InboundReceiptHeaderWriteInput,
  errors: ErrorItem[],
  /** 호출을 «가로질러» 공급사 LOT 겹침을 보려면 한 집합을 넘긴다(`:split` 의 두 part). */
  lotNos = new Set<string>(),
  /** 같은 이유로 제품코드·공급사 대조 대상도 호출을 가로질러 모은다(`:split` 의 두 part). */
  lotCodeChecks: MaterialLotCodeCheck[] = [],
): CodeCheck[] {
  if (Number.isNaN(Date.parse(header.receiptDatetime))) {
    errors.push(field(`${at}receiptDatetime`, ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  // 「`exceptionTypeCode` 가 있으면 필수」(계약).
  if (header.exceptionTypeCode != null && !header.exceptionReason) {
    errors.push(field(`${at}exceptionReason`, ERROR_CODE.PAIR, '예외 유형과 사유는 짝입니다.'));
  }
  assertLines(at, header.plantId, header.supplierId, header.lines, errors, lotNos, lotCodeChecks);

  return [
    {
      field: `${at}exceptionTypeCode`,
      value: header.exceptionTypeCode,
      groupCode: 'INBOUND_RECEIPT_EXCEPTION_TYPE',
    },
    ...header.lines.map((line, index) => ({
      field: `${at}lines.${index}.substituteLotReasonCode`,
      value: line.substituteLotReasonCode,
      groupCode: 'SUBSTITUTE_LOT_REASON',
    })),
  ];
}

/** 저장하지 않는 두 칸의 형식 검사 — 분리는 이 둘을 «바깥에서 한 번만» 받는다(§2-5). */
export function collectMomentErrors(businessDate: string, occurredAt: string, errors: ErrorItem[]): void {
  // ⛔ 정규식만으로는 `2026-13-39` 가 통과한다 — 저장은 안 되지만 채번의 기간 축으로 들어가
  //    `IR-20261339-0001` 이 `inbound_receipt_no` 에 «영구히» 남는다. 달력에 있는 날인지 함께 본다
  //    (`lot-rules.ts:assertDay` 와 같은 축 · import 는 안 한다 · §6-4).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || Number.isNaN(Date.parse(`${businessDate}T00:00:00Z`))) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'));
  }
  if (Number.isNaN(Date.parse(occurredAt))) {
    errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
}

/**
 * 트랜잭션을 열기 «전»의 검증 — 잠근 뒤 400 을 내면 부모 P/O 를 헛되이 붙잡는다.
 * ⛔ `src/trace/lot/lot-rules.ts` 의 날짜 도우미를 가로질러 부르지 않는다(§6-4).
 */
export async function assertWritable(prisma: PrismaService, input: InboundReceiptCreateInput): Promise<void> {
  if (input.lines.length === 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [lineRequired('lines')]);
  }

  const errors: ErrorItem[] = [];
  const lotCodeChecks: MaterialLotCodeCheck[] = [];
  const checks = collectHeaderErrors('', input, errors, undefined, lotCodeChecks);
  collectMomentErrors(input.businessDate, input.occurredAt, errors);
  // ⭐ 「P/O 를 고르지 않고 진행할 때 필수」(계약 `InboundReceiptCreate` description) —
  //   무발주 입하에 승인을 걸지 않는 대신 예외 유형·사유 기록이 통제다(R-7 ②).
  if (input.lines.some((line) => line.purchaseOrderLineId == null) && input.exceptionTypeCode == null) {
    errors.push(
      field('exceptionTypeCode', ERROR_CODE.REQUIRED, 'P/O 를 고르지 않은 라인이 있으면 예외 유형이 필요합니다.'),
    );
  }
  errors.push(...(await assertAttachedLotCodes(prisma, lotCodeChecks)));
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  await assertCodeValues(prisma, checks);
}

/**
 * 사전부착 LOT 번호(통보 277 형식)에서 파싱된 제품코드·공급사코드가 실 입하 라인·공급사와
 * 같은지 대조한다(§2-3 결정 5). 수량 칸은 스냅샷이라 비교하지 않는다.
 *
 * ⛔ 마스터 행이 없으면 조용히 건너뛴다 — 「없는 품목/공급사」를 여기서 새 오류로 만들지
 *    않는다(그건 다른 결정 사안). ⛔ `InboundReceiptService` 의 기존 `item.findMany`
 *    (검사대상 여부 조회)와 합치지 않는다 — 트랜잭션 밖·안이 다르고, 이 검사는 사전-트랜잭션
 *    전용이라는 이 파일의 불변식을 지킨다.
 */
export async function assertAttachedLotCodes(
  prisma: PrismaService,
  checks: readonly MaterialLotCodeCheck[],
): Promise<ErrorItem[]> {
  if (checks.length === 0) return [];

  const itemIds = [...new Set(checks.map((check) => check.itemId))];
  const supplierIds = [...new Set(checks.map((check) => check.supplierId))];
  const [items, suppliers] = await Promise.all([
    prisma.item.findMany({ where: { item_id: { in: itemIds } }, select: { item_id: true, item_code: true } }),
    prisma.partner.findMany({ where: { partner_id: { in: supplierIds } }, select: { partner_id: true, partner_code: true } }),
  ]);
  const itemCodeOf = new Map(items.map((item) => [item.item_id.toString(), item.item_code]));
  const supplierCodeOf = new Map(suppliers.map((supplier) => [supplier.partner_id.toString(), supplier.partner_code]));

  const errors: ErrorItem[] = [];
  for (const check of checks) {
    const itemCode = itemCodeOf.get(check.itemId.toString());
    const supplierCode = supplierCodeOf.get(check.supplierId.toString());
    if (itemCode === undefined || supplierCode === undefined) continue;
    if (itemCode !== check.itemCode) {
      errors.push(field(check.at, ERROR_CODE.INVALID, '사전부착 LOT 번호의 제품코드가 입하 라인의 품목과 다릅니다.'));
      continue;
    }
    if (supplierCode !== check.supplierCode) {
      errors.push(field(check.at, ERROR_CODE.INVALID, '사전부착 LOT 번호의 공급사코드가 입하 공급사와 다릅니다.'));
    }
  }
  return errors;
}

function assertLines(
  prefix: string,
  plantId: number,
  supplierId: number,
  lines: InboundReceiptLineWriteInput[],
  errors: ErrorItem[],
  lotNos: Set<string>,
  lotCodeChecks: MaterialLotCodeCheck[],
): void {
  for (const [index, line] of lines.entries()) {
    const at = `${prefix}lines.${index}`;
    // 「`supplierLotMissing` 이 참일 때 필수」(계약).
    if (line.supplierLotMissing && !line.substituteLotReasonCode) {
      errors.push(field(`${at}.substituteLotReasonCode`, ERROR_CODE.PAIR, '대체 LOT 사유가 필요합니다.'));
    }
    const attached = supplierLotLabelAttached(line);
    if (line.supplierLotMissing && attached) {
      errors.push(
        field(`${at}.supplierLotLabelAttached`, ERROR_CODE.PAIR, '공급사 LOT 번호가 없으면 라벨이 부착될 수 없습니다.'),
      );
    }
    if (!line.supplierLotMissing && !line.supplierLotNo?.trim()) {
      errors.push(
        field(
          `${at}.supplierLotNo`,
          ERROR_CODE.PAIR,
          '공급사 LOT 번호가 없으면 supplierLotMissing 이 참이어야 합니다.',
        ),
      );
    }
    // ⛔ 안 가르면 `uq_lot(plant_id, lot_no)` P2002 로 트랜잭션이 통째로 죽는다(R-7 ③).
    //    키는 그 유일 제약과 «같은 쌍»이다 — 공장이 다르면 같은 번호를 허용한다(물리가 허용한다).
    if (attached && line.supplierLotNo) {
      // 형식이 깨진 라인은 여기서 이미 INVALID 를 보고했다 — 파싱 못 한 값으로 제품코드·
      // 공급사 대조를 «또» 시도해 같은 라인에 오류 두 개를 겹쳐 싣지 않는다.
      try {
        const segments = parseMaterialLotNo(line.supplierLotNo);
        lotCodeChecks.push({
          at: `${at}.supplierLotNo`,
          itemId: line.itemId,
          itemCode: segments.itemCode,
          supplierId,
          supplierCode: segments.supplierCode,
        });
      } catch {
        errors.push(field(`${at}.supplierLotNo`, ERROR_CODE.INVALID, '사전부착 LOT 번호 형식이 올바르지 않습니다.'));
      }
      const key = `${plantId}\u0000${line.supplierLotNo}`;
      if (lotNos.has(key)) {
        errors.push(field(`${at}.supplierLotNo`, ERROR_CODE.INVALID, '한 요청 안에서 겹칩니다.'));
      }
      lotNos.add(key);
    }
    // ⛔ `ck_inbound_expiry` 위반은 알려진 오류가 아니라 500 으로 샌다 — 손으로 앞당긴다.
    if (line.expiryDate && line.manufacturedDate && line.expiryDate < line.manufacturedDate) {
      errors.push(field(`${at}.expiryDate`, ERROR_CODE.INVALID, '제조일보다 앞설 수 없습니다.'));
    }
  }
}
