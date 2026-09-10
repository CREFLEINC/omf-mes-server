import { Prisma } from '@prisma/client';

import { assertUpdated } from '../../common/optimistic-lock';

/**
 * 출하 상태 쓰기 셋(`:confirm`·`:request-cancel`·`:cancel`)이 함께 쓰는 잠금·판정.
 * ⭐ 사용처가 «셋»이 되어 모았다 — 확정(PR ⑥)이 혼자일 때는 그 파일 안에 있었다
 *    (CLAUDE.md 「사용처 하나뿐인 추상화 금지」). 상태 판정의 «문구»는 오퍼레이션마다 달라 각자 둔다.
 */

export type Tx = Prisma.TransactionClient;

export const STATUS_COLUMN = 'logistics.shipment.status_code';
export const CANCELLED = 'CANCELLED';
export const CONFIRMED = 'CONFIRMED';
/** ⛔ 유형 접두가 필수다 — 없으면 다른 축의 결재가 취소 품의를 대신한다(I-5.md §6-2 · 같은 규약). */
export const CANCEL_APPROVAL_TYPE = 'SHIPMENT_CANCEL';
export const SHIPMENT_TARGET = 'SHIPMENT';

/** `ShipmentConflictResponse.code` enum 5값 중 서비스가 내는 넷(`DUPLICATE_KEY` 는 공용 가드가 낸다). */
export const CONFLICT_CODE = {
  INVALID_STATE: 'INVALID_STATE',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  CANCEL_IN_PROGRESS: 'CANCEL_IN_PROGRESS',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
} as const;

export interface LockedShipment {
  shipment_id: bigint;
  shipment_no: string;
  shipment_request_id: bigint;
  warehouse_id: bigint;
  shipped_at: Date | null;
  status_code: string;
  version_no: number;
}

/** ⛔ 확정과 취소가 경합하면 둘째가 첫째의 커밋을 기다렸다가 바뀐 상태를 본다 — 그래서 잠근다. */
export async function lockShipment(tx: Tx, shipmentId: number): Promise<LockedShipment | undefined> {
  const rows = await tx.$queryRaw<LockedShipment[]>`
    SELECT shipment_id, shipment_no, shipment_request_id, warehouse_id, shipped_at, status_code, version_no
      FROM logistics.shipment
     WHERE shipment_id = ${BigInt(shipmentId)}
       FOR UPDATE`;
  return rows[0];
}

/**
 * ⭐ J-7 — 시드 `SHIPMENT_STATUS` 3값에 `CANCEL_REQUESTED` 가 «없어» 상태로는 못 가린다. 열린 결재가
 * 유일한 원천이다.
 */
export async function hasOpenCancel(tx: Tx, shipmentId: bigint): Promise<boolean> {
  const open = await tx.approval_request.findFirst({
    where: {
      target_type_code: SHIPMENT_TARGET,
      target_id: shipmentId,
      approval_type_code: CANCEL_APPROVAL_TYPE,
      status_code: 'PENDING',
    },
    select: { approval_request_id: true },
  });
  return open !== null;
}

/**
 * 판 번호 — 행을 잠근 뒤 «한 번» 본다. ⛔ 잠금 아래에서 조건부 UPDATE 로 한 번 더 보지 않는다 —
 * 그 두 번째 검사는 도달할 수 없어 반증 불가한 단언이 된다(이 이슈의 되풀이 병).
 */
export function assertVersion(locked: LockedShipment, version: number): void {
  assertUpdated(locked.version_no === version ? 1 : 0, 'user', {
    code: CONFLICT_CODE.VERSION_CONFLICT,
    currentVersion: String(locked.version_no),
  });
}
