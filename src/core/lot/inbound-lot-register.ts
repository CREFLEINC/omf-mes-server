import { INBOUND_RECEIPT_LINE_SOURCE } from './inbound-lot';
import { LotHoldService } from './lot-hold.service';
import { LotLifecycleService } from './lot-lifecycle.service';
import { LotQualityStatusService } from './lot-quality-status.service';
import { INITIAL_LOT_STATUS, INSPECTION_HOLD_REASON, type Tx } from './lot-registry.service';
import { MATERIAL_LOT_BATCH_SOURCE } from './lot-source';

/**
 * 자재 관리 LOT 을 입하 LOT 에 등록·해제한다(피처 005 R-3 · R-5). 생애·품질·보류 세 축과 원천을 한 자리에서 옮긴다 —
 * PDA 받기(`:receive`)와 등록 해제(`:unregister-lots`)가 같은 규칙을 쓴다. 잠금·검사(대기인가·이 입하 LOT 의 LOT 인가)는 호출자 몫이다.
 */

/** 생애·품질 이력의 원천 문서 — 입하 LOT. */
export const INBOUND_LOT_DOCUMENT = 'INBOUND_LOT';
/** 입하 중 — 받기·해제·공급사 LOT 입력은 이 상태에서만(마감 이상은 구성 고정, `VOIDED` 는 빈 자리). */
export const INBOUND_LOT_RECEIVING = 'RECEIVING';
/**
 * 등록 해제가 닫는 보류의 해제 사유. ⚠ 시드 `LOT_HOLD_RELEASE_REASON` 에 「등록 해제」 값이 없다 — 코드값을 더하려면
 * 마이그레이션이 필요해 S4 는 가장 가까운 기존 값을 쓴다(해제는 사람이 화면에서 직접 하는 일이다).
 */
const UNREGISTER_RELEASE_REASON = 'MANAGER_OVERRIDE';

export type InboundLotActor = { appUserId: number; workerId?: never } | { appUserId?: never; workerId: bigint };

export interface InboundLotRegisterDeps {
  lifecycle: LotLifecycleService;
  quality: LotQualityStatusService;
  holds: LotHoldService;
}

export interface MaterialLotRegisterInput {
  inboundLotId: bigint;
  inboundReceiptLineId: bigint;
  /** 미리 만든 대기 LOT(L4 로 옮길 것). */
  waitingLotIds: bigint[];
  /** 이 받기가 바로 ACTIVE 로 만든 사전부착 라벨 LOT — 생애 전이 없이 품질·보류만. */
  createdLotIds: bigint[];
  inspectionNeeded: boolean;
  actor: InboundLotActor;
  at: Date;
}

/**
 * 받기: 원천을 입하 줄로·`inbound_lot_id`·생애 L4, 그다음 품질 — 검사 필요면 보류(검사 대기 그대로), 아니면 C21 정상.
 * ⛔ 보류는 생애를 옮긴 «뒤»에 건다 — 코어 `holdWithin` 이 대기 자재 LOT 을 막는다(R-3).
 */
export async function registerMaterialLotsWithin(tx: Tx, deps: InboundLotRegisterDeps, input: MaterialLotRegisterInput): Promise<void> {
  const all = [...input.waitingLotIds, ...input.createdLotIds];
  if (all.length === 0) return;
  const moved = await deps.lifecycle.moveWithin(tx, {
    lotIds: input.waitingLotIds, action: 'material-inbound-registered',
    sourceDocumentTypeCode: INBOUND_LOT_DOCUMENT, sourceDocumentId: input.inboundLotId, changedAt: input.at,
  });
  if (moved.skippedLotIds.length > 0) throw new Error(`대기가 아닌 LOT 을 받으려 했다: ${moved.skippedLotIds.join(',')}`);
  await tx.lot.updateMany({
    where: { lot_id: { in: all } },
    data: {
      source_type_code: INBOUND_RECEIPT_LINE_SOURCE, source_id: input.inboundReceiptLineId, inbound_lot_id: input.inboundLotId,
      updated_by: input.actor.appUserId === undefined ? null : BigInt(input.actor.appUserId),
    },
  });
  if (input.inspectionNeeded) {
    const locked = await deps.holds.lockLotsWithin(tx, all);
    await deps.holds.holdWithin(
      tx, locked,
      all.map((lotId) => ({ lotId, reasonCode: INSPECTION_HOLD_REASON, targetLotStatusCode: INITIAL_LOT_STATUS })),
      holdActor(input.actor, input.at),
    );
    return;
  }
  await deps.quality.moveWithin(tx, all, 'inspection-not-required', {
    ...qualityActor(input.actor), changedAt: input.at,
    sourceDocumentTypeCode: INBOUND_LOT_DOCUMENT, sourceDocumentId: input.inboundLotId,
  });
}

export interface MaterialLotUnregisterInput {
  inboundLotId: bigint;
  /** LOT 마다 되돌릴 발행 묶음(받기 이벤트가 적은 것). */
  lots: { lotId: bigint; batchId: bigint }[];
  actor: InboundLotActor;
  at: Date;
}

/**
 * 해제: 검사 대기 보류 닫음 → 정상이던 LOT 은 C31(검사 대기) → 생애 L6(대기) → 원천을 묶음으로·`inbound_lot_id` 비움.
 * 검사 필요 품목의 LOT 은 이미 검사 대기라 품질 축이 그대로다(C31 의 `from` 이 정상뿐이다).
 */
export async function unregisterMaterialLotsWithin(tx: Tx, deps: InboundLotRegisterDeps, input: MaterialLotUnregisterInput): Promise<void> {
  const lotIds = input.lots.map((lot) => lot.lotId);
  if (lotIds.length === 0) return;
  const locked = await deps.holds.lockLotsWithin(tx, lotIds);
  for (const lotId of lotIds) {
    await deps.holds.releaseWithin(tx, locked, { lotId, reasonCode: INSPECTION_HOLD_REASON },
      { releaseReasonCode: UNREGISTER_RELEASE_REASON }, holdActor(input.actor, input.at));
  }
  await deps.quality.moveWithin(tx, lotIds, 'material-inbound-unregistered-quality-reset', {
    ...qualityActor(input.actor), changedAt: input.at,
    sourceDocumentTypeCode: INBOUND_LOT_DOCUMENT, sourceDocumentId: input.inboundLotId,
  });
  const moved = await deps.lifecycle.moveWithin(tx, {
    lotIds, action: 'material-inbound-unregistered',
    sourceDocumentTypeCode: INBOUND_LOT_DOCUMENT, sourceDocumentId: input.inboundLotId, changedAt: input.at,
  });
  if (moved.skippedLotIds.length > 0) throw new Error(`입하되지 않은 LOT 을 해제하려 했다: ${moved.skippedLotIds.join(',')}`);
  for (const lot of input.lots) {
    await tx.lot.update({
      where: { lot_id: lot.lotId },
      data: {
        source_type_code: MATERIAL_LOT_BATCH_SOURCE, source_id: lot.batchId, inbound_lot_id: null,
        updated_by: input.actor.appUserId === undefined ? null : BigInt(input.actor.appUserId),
      },
    });
  }
}

function holdActor(actor: InboundLotActor, at: Date): { at: Date; by: bigint } | { at: Date; workerId: bigint } {
  return actor.appUserId === undefined ? { at, workerId: actor.workerId } : { at, by: BigInt(actor.appUserId) };
}

function qualityActor(actor: InboundLotActor): { changedBy: bigint } | { changedWorkerId: bigint } {
  return actor.appUserId === undefined ? { changedWorkerId: actor.workerId } : { changedBy: BigInt(actor.appUserId) };
}
