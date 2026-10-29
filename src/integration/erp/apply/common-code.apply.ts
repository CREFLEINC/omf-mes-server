import { ERP_WAREHOUSE_GROUP } from '../../../common/master';
import { RowTable, Tx } from '../inbound-cycle';
import { COMMON_CODE, RelayRow, requiredText, text } from '../relay-tables';

/**
 * ERP 공통코드 → `mdm.code_group` / `code_value`. 그룹 코드는 ERP 의 TYPE_CODE 그대로다 —
 * 2026-09-08 대조에서 MES 그룹과 겹치는 이름이 없었다(`erp-gateway/docs/mes-seed-mapping.md` §3-5).
 *
 * ⭐ ERP 가 정본이다. 그룹을 `is_system_owned` 로 세워 화면에서 못 고치게 하고, 받을 때마다
 * ERP 값으로 덮는다. `updated_by` 를 비우는 것은 세션 없는 연계가 고쳤다는 표시다.
 */
export const commonCodeTable: RowTable = {
  source: COMMON_CODE,
  async apply(tx: Tx, row: RelayRow): Promise<void> {
    const groupCode = requiredText(row, 'TYPE_CODE');
    const groupId = await upsertGroup(tx, groupCode, requiredText(row, 'TYPE_NAME'));
    await upsertValue(tx, groupId, row);
    if (groupCode === ERP_WAREHOUSE_GROUP) await renameErpWarehouses(tx, row);
  },
};

/** ERP 창고 이름은 ERP 를 따른다(사용자 결정 2026-10-29 · 장부 P-148) — 같은 코드의 MES 창고 이름을 덮는다. */
async function renameErpWarehouses(tx: Tx, row: RelayRow): Promise<void> {
  const name = requiredText(row, 'CODE_NAME');
  await tx.warehouse.updateMany({
    where: { warehouse_code: requiredText(row, 'CODE'), NOT: { warehouse_name: name } },
    data: { warehouse_name: name, updated_by: null, version_no: { increment: 1 } },
  });
}

async function upsertGroup(tx: Tx, groupCode: string, groupName: string): Promise<bigint> {
  const group = await tx.code_group.findUnique({
    where: { group_code: groupCode },
  });
  if (group === null) {
    const created = await tx.code_group.create({
      data: {
        group_code: groupCode,
        group_name: groupName,
        is_system_owned: true,
      },
    });
    return created.code_group_id;
  }
  if (group.group_name !== groupName || !group.is_system_owned || !group.is_active) {
    await tx.code_group.update({
      where: { code_group_id: group.code_group_id },
      data: {
        group_name: groupName,
        is_system_owned: true,
        is_active: true,
        updated_by: null,
        version_no: { increment: 1 },
      },
    });
  }
  return group.code_group_id;
}

async function upsertValue(tx: Tx, codeGroupId: bigint, row: RelayRow): Promise<void> {
  const code = requiredText(row, 'CODE');
  const codeName = requiredText(row, 'CODE_NAME');
  // T_FLAG 는 I·U·D 다. 지금까지 I 만 왔다 — D 는 지우지 않고 끈다.
  const isActive = text(row, 'T_FLAG') !== 'D';
  const value = await tx.code_value.findUnique({
    where: { code_group_id_code: { code_group_id: codeGroupId, code } },
  });
  if (value === null) {
    await tx.code_value.create({
      data: {
        code_group_id: codeGroupId,
        code,
        code_name: codeName,
        name_ko: codeName,
        is_active: isActive,
      },
    });
    return;
  }
  if (value.code_name !== codeName || value.name_ko !== codeName || value.is_active !== isActive) {
    await tx.code_value.update({
      where: { code_value_id: value.code_value_id },
      data: {
        code_name: codeName,
        name_ko: codeName,
        is_active: isActive,
        updated_by: null,
        version_no: { increment: 1 },
      },
    });
  }
}
