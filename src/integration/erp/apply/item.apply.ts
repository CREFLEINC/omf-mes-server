import { RowTable, Tx } from '../inbound-cycle';
import { ITEM, RelayRow, isCancel, requiredText, text } from '../relay-tables';

/**
 * ERP 품목 → `mdm.item`. ERP 는 공장별로 보내지만 MES 품목은 품목코드 하나다 — 두 공장에 모두
 * 있는 544건은 이름·단위·계정이 모두 같았다(`erp-gateway/docs/mes-seed-mapping.md` §5-1).
 *
 * ⭐ ERP 원본 칸(이름·유형·기본단위·규격·품목그룹)만 맞춘다. 번역 이름·LOT 관리·검사 여부·사용 여부
 * 같은 MES 확장 칸은 화면이 고치는 자리라 덮지 않는다(`item.service.ts` ItemUpdate).
 */
export const itemTable: RowTable = {
  source: ITEM,
  async apply(tx: Tx, row: RelayRow): Promise<void> {
    const itemCode = requiredText(row, 'ITEM_CD');
    const values = {
      item_name: requiredText(row, 'ITEM_NM'),
      item_type_code: itemTypeOf(text(row, 'ITEM_ACCT_CD')),
      erp_spec: text(row, 'SPEC') === '' ? null : text(row, 'SPEC'),
      erp_item_group_code: text(row, 'ITEM_GROUP_CD') === '' ? null : text(row, 'ITEM_GROUP_CD'),
    };
    const uomId = await uomOf(tx, requiredText(row, 'BASIC_UNIT'));

    const item = await tx.item.findUnique({ where: { item_code: itemCode } });
    if (item === null) {
      // 운영 초기 데이터(`deploy/seed/mes-initial-data.sql`)처럼 원본 이름을 베트남어 칸에도 둔다.
      await tx.item.create({
        data: {
          item_code: itemCode,
          ...values,
          name_vi: values.item_name,
          base_uom_id: uomId,
          is_active: !isCancel(row),
        },
      });
      return;
    }
    // 재고·BOM·실적이 기본단위로 쌓여 있다 — 단위만 바꾸면 수량의 뜻이 바뀐다.
    if (item.base_uom_id !== uomId) {
      throw new Error(`품목 ${itemCode} 의 기본단위가 바뀌었다 — 재고 환산을 사람이 확인해야 한다`);
    }
    const changed =
      item.item_name !== values.item_name ||
      item.item_type_code !== values.item_type_code ||
      item.erp_spec !== values.erp_spec ||
      item.erp_item_group_code !== values.erp_item_group_code;
    // 사용 여부는 MES 도 고친다 — ERP 가 취소했을 때만 끈다.
    const cancel = isCancel(row) && item.is_active;
    if (changed || cancel) {
      await tx.item.update({
        where: { item_id: item.item_id },
        data: {
          ...values,
          ...(cancel ? { is_active: false } : {}),
          updated_by: null,
          version_no: { increment: 1 },
        },
      });
    }
  },
};

/** ERP 품목계정 → `ITEM_TYPE`. 부자재(35)는 원자재에 합치지 않는다. */
const ITEM_TYPES: Record<string, string> = {
  '10': 'FINISHED',
  '20': 'SEMI_FINISHED',
  '30': 'RAW_MATERIAL',
  '35': 'SUBSIDIARY_MATERIAL',
  '50': 'MERCHANDISE',
};

function itemTypeOf(account: string): string {
  const type = ITEM_TYPES[account];
  if (type === undefined) throw new Error(`모르는 품목계정 ${account}`);
  return type;
}

/** ERP 단위 코드를 글자 그대로 찾는다 — GR 을 G 로 바꾸지 않는다. */
async function uomOf(tx: Tx, uomCode: string): Promise<bigint> {
  const uom = await tx.uom.findUnique({ where: { uom_code: uomCode }, select: { uom_id: true } });
  if (uom === null) throw new Error(`단위 ${uomCode} 이 없다`);
  return uom.uom_id;
}
