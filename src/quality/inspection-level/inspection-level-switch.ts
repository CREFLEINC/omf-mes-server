import { Tx } from '../../core/lot';
import { isInspectionLevel } from './inspection-level-rules';

const IQC = 'IQC';

export interface IqcInspectionLevelRecord {
  inspectionRequestId: bigint;
  inspectionTypeCode: string;
  itemId: bigint;
}

/**
 * IQC 확정 때 그 품목의 현재 검사 수준을 의뢰에 기록한다(omf-all-around#64 · 장부 P-87).
 * ⭐ 확정 부수효과(`applyConfirmEffects`) 안에서 «같은 트랜잭션»으로 돈다 — 관리웹 `:confirm` 과 오프라인 큐 확정이 함께 탄다.
 * ⭐ 의뢰마다 «첫 확정 한 번»만 기록한다 — 재검사 회차·재저장은 이미 채워져 있어 지나간다.
 * ⛔ 자동 전환은 없다 — 수준은 사용자가 정한 것만 쓴다(omf-all-around#133 · 담당자 결정 2026-10-22). 연속 합격 수도 세지 않는다.
 * 수준 행이 없는 품목은 아무것도 하지 않는다.
 */
export async function recordIqcInspectionLevelWithin(tx: Tx, input: IqcInspectionLevelRecord): Promise<void> {
  if (input.inspectionTypeCode !== IQC) return;
  const [level] = await tx.$queryRaw<{ inspection_level_code: string }[]>`
    SELECT inspection_level_code
      FROM quality.item_inspection_level
     WHERE item_id = ${input.itemId}`;
  if (level === undefined || !isInspectionLevel(level.inspection_level_code)) return;
  await tx.inspection_request.updateMany({
    where: { inspection_request_id: input.inspectionRequestId, inspection_level_code: null },
    data: { inspection_level_code: level.inspection_level_code },
  });
}
