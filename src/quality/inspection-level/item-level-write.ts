import { Prisma } from '@prisma/client';

import { assertUpdated } from '../../common/optimistic-lock';
import { InspectionLevelCode } from './inspection-level-rules';

/**
 * 검사기준 기본 정보 수정과 같은 트랜잭션에서 품목 검사 수준을 지정·변경한다(omf-all-around#357 — 둘 중 하나만 저장되지 않게).
 * 수준 행이 없으면 만들고, 있으면 수준이 바뀔 때만 고친다. 어느 쪽이든 바뀌면 수동(MANUAL) 이력 1건을 남긴다.
 */
export async function writeItemLevelInTx(
  tx: Prisma.TransactionClient,
  itemId: bigint,
  levelCode: InspectionLevelCode,
  reasonInput: string | null | undefined,
  appUserId: number | undefined,
): Promise<void> {
  const reason = reasonInput?.trim() || null;
  const current = await tx.item_inspection_level.findUnique({ where: { item_id: itemId } });
  if (current !== null && current.inspection_level_code === levelCode) return;
  if (current === null) {
    await tx.item_inspection_level.create({
      data: {
        item_id: itemId,
        inspection_level_code: levelCode,
        auto_switch_enabled: false,
        created_by: appUserId ?? null,
        updated_by: appUserId ?? null,
      },
    });
  } else {
    // ⛔ 읽은 판으로 잠근다 — 그 사이 IQC 판정 확정 등이 수준을 바꿨으면 기본 정보까지 함께 되돌린다.
    const updated = await tx.item_inspection_level.updateMany({
      where: { item_inspection_level_id: current.item_inspection_level_id, version_no: current.version_no },
      data: {
        inspection_level_code: levelCode,
        consecutive_accept_count: 0,
        updated_at: new Date(),
        updated_by: appUserId ?? null,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count, 'user', { code: 'VERSION_CONFLICT', currentVersion: String(current.version_no) });
  }
  await tx.item_inspection_level_history.create({
    data: {
      item_id: itemId,
      from_level_code: current?.inspection_level_code ?? null,
      to_level_code: levelCode,
      change_type_code: 'MANUAL',
      reason,
      changed_by: appUserId ?? null,
    },
  });
}
