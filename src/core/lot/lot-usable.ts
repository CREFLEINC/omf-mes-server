import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * 재고를 보지 않는 LOT 쓰기(보류·부적합·특채)의 공용 관문(피처 005 R-3). 재고를 쓰는 경로는
 * 대기 LOT 에 재고가 없어 이미 막힌다 — 이 관문은 재고 없이도 서는 쓰기만 막는다.
 * ⛔ 자재 LOT 만 본다 — 생산 LOT 선발행 슬롯도 생애 `WAITING` 이지만 그쪽은 지금처럼 쓸 수 있어야 한다.
 */
export interface LotUsableFacts {
  lot_no?: string;
  lot_type_code: string;
  lifecycle_status_code: string | null;
}

const MATERIAL_LOT_TYPE = 'MATERIAL';
const BLOCKED: Readonly<Record<string, string>> = {
  WAITING: '아직 입하되지 않은 LOT',
  VOIDED: '폐기된 LOT',
};

/** 막히면 그 까닭(문구), 쓸 수 있으면 null. */
export function materialLotBlockReason(lot: LotUsableFacts): string | null {
  if (lot.lot_type_code !== MATERIAL_LOT_TYPE || lot.lifecycle_status_code === null) return null;
  return BLOCKED[lot.lifecycle_status_code] ?? null;
}

/** 읽지 못한 LOT(`undefined`)은 건너뛴다 — 존재 판정은 호출자의 몫이다. */
export function assertMaterialLotsUsable(lots: readonly (LotUsableFacts | undefined)[]): void {
  for (const lot of lots) {
    if (lot === undefined) continue;
    const reason = materialLotBlockReason(lot);
    if (reason === null) continue;
    throw new ContractException(HttpStatus.BAD_REQUEST, [{
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: `${reason}입니다.${lot.lot_no === undefined ? '' : ` (LOT ${lot.lot_no})`}`,
    }]);
  }
}
