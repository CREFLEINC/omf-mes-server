import { HttpStatus } from '@nestjs/common';

import { ConflictException, ContractException } from '../../common/errors';
import { Tx } from '../../core/lot';

/** `quality.disposition_approval.status_code` — 결재 진행 중. */
export const PENDING_DISPOSITION_APPROVAL = 'PENDING';
export const PENDING_DISPOSITION_MESSAGE = '결재 진행 중인 처분이 있습니다. 결재가 끝난 뒤 처분하세요.';

/**
 * 결재 진행 중인 폐기·선별(omf-all-around#352)이 있는 부적합에는 다른 처분·특채를 받지 않는다 — 결재가 승인돼 `:apply` 할 때
 * 남은 수량·LOT 이 요청 때와 달라지면 승인받은 처분을 그대로 반영할 수 없다. ⛔ 호출자가 부적합 행을 `FOR UPDATE` 로 잡은 «뒤»에 부른다.
 */
export async function hasPendingDispositionApproval(tx: Tx, nonconformanceId: bigint): Promise<boolean> {
  const count = await tx.disposition_approval.count({
    where: { nonconformance_id: nonconformanceId, status_code: PENDING_DISPOSITION_APPROVAL },
  });
  return count > 0;
}

/** 처분 판정 저장(계열 봉투 `QualityConflictResponse`) — 409 `INVALID_STATE`. */
export async function assertNoPendingDispositionApproval(tx: Tx, nonconformanceId: bigint): Promise<void> {
  if (await hasPendingDispositionApproval(tx, nonconformanceId)) {
    throw new ConflictException('user', PENDING_DISPOSITION_MESSAGE, { code: 'INVALID_STATE' });
  }
}

/** 특채 요청(봉투 `ErrorResponse`) — 409 `INVALID_STATE`. */
export async function assertNoPendingDispositionApprovalForConcession(tx: Tx, nonconformanceId: bigint): Promise<void> {
  if (await hasPendingDispositionApproval(tx, nonconformanceId)) {
    throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: 'INVALID_STATE', message: PENDING_DISPOSITION_MESSAGE }]);
  }
}
