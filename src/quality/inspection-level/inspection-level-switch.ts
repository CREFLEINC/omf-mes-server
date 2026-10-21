import { Tx } from '../../core/lot';
import { isInspectionLevel, NONE, nextInspectionLevel } from './inspection-level-rules';

const IQC = 'IQC';
const AUTO = 'AUTO';

export interface IqcJudgmentCount {
  inspectionRequestId: bigint;
  inspectionTypeCode: string;
  itemId: bigint;
  judgment: string;
  changedAt: Date;
  appUserId?: number;
  workerId?: bigint;
}

interface LockedLevel {
  item_inspection_level_id: bigint;
  inspection_level_code: string;
  auto_switch_enabled: boolean;
  consecutive_accept_count: number;
}

/**
 * IQC 확정 판정 하나를 그 품목의 검사 수준에 센다(omf-all-around#64 · 장부 P-87).
 * ⭐ 확정 부수효과(`applyConfirmEffects`) 안에서 «같은 트랜잭션»으로 돈다 — 관리웹 `:confirm` 과 오프라인 큐 확정이 함께 탄다.
 * ⭐ 의뢰마다 «첫 확정 한 번»만 센다 — 의뢰의 `inspection_level_code` 가 비어 있을 때만 채우고 센다. 재검사 회차·재저장은 이미
 *    채워져 있어 지나간다(담당자 결정 2026-10-21 「재검사는 연속 횟수를 바꾸지 않는다」).
 * 수준 행이 없는 품목은 아무것도 하지 않는다(지금처럼 동작). 무검사·자동 끔이면 수준만 기록하고 세지 않는다.
 */
export async function countIqcJudgmentWithin(tx: Tx, input: IqcJudgmentCount): Promise<void> {
  if (input.inspectionTypeCode !== IQC) return;
  // 같은 품목의 두 LOT 이 동시에 확정되면 연속 수가 서로를 덮는다 — 수준 행을 잡고 센다.
  const [level] = await tx.$queryRaw<LockedLevel[]>`
    SELECT item_inspection_level_id, inspection_level_code, auto_switch_enabled, consecutive_accept_count
      FROM quality.item_inspection_level
     WHERE item_id = ${input.itemId}
       FOR UPDATE`;
  if (level === undefined || !isInspectionLevel(level.inspection_level_code)) return;
  const marked = await tx.inspection_request.updateMany({
    where: { inspection_request_id: input.inspectionRequestId, inspection_level_code: null },
    data: { inspection_level_code: level.inspection_level_code },
  });
  if (marked.count === 0) return;
  if (!level.auto_switch_enabled || level.inspection_level_code === NONE) return;

  const step = nextInspectionLevel(
    { level: level.inspection_level_code, consecutiveAcceptCount: level.consecutive_accept_count },
    input.judgment,
  );
  if (step.level === level.inspection_level_code && step.consecutiveAcceptCount === level.consecutive_accept_count) return;
  await tx.item_inspection_level.update({
    where: { item_inspection_level_id: level.item_inspection_level_id },
    data: {
      inspection_level_code: step.level,
      consecutive_accept_count: step.consecutiveAcceptCount,
      updated_at: input.changedAt,
      // 화면이 든 If-Match 가 자동 전환 뒤의 행을 덮지 않게 버전을 올린다.
      version_no: { increment: 1 },
    },
  });
  if (!step.switched) return;
  await tx.item_inspection_level_history.create({
    data: {
      item_id: input.itemId,
      from_level_code: level.inspection_level_code,
      to_level_code: step.level,
      change_type_code: AUTO,
      consecutive_accept_count: step.acceptStreak ?? null,
      inspection_request_id: input.inspectionRequestId,
      changed_at: input.changedAt,
      changed_by: input.appUserId ?? null,
      changed_worker_id: input.appUserId === undefined ? (input.workerId ?? null) : null,
    },
  });
}
