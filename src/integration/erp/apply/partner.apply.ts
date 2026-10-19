import { RowTable, Tx } from '../inbound-cycle';
import { PARTNER, RelayRow, isCancel, requiredText } from '../relay-tables';

/**
 * ERP 거래처 → `mdm.partner` / `partner_role`. 거래처 본체는 ERP 수신본이고 역할은 MES 도
 * 붙인다(`partner.service.ts`) — ERP 가 정하는 역할(공급사·고객)만 맞추고, 사용자가 붙인
 * 폐기·외주 같은 역할은 남긴다.
 *
 * 주소·대표자·사업자번호·전화는 담을 칸이 없어 원본 기록(payload)에만 남는다.
 */
export const partnerTable: RowTable = {
  source: PARTNER,
  async apply(tx: Tx, row: RelayRow): Promise<void> {
    const code = requiredText(row, 'BP_CD');
    const name = requiredText(row, 'BP_NM');
    const roles = rolesOf(requiredText(row, 'BP_TYPE'));

    const partner = await tx.partner.findUnique({
      where: { partner_code: code },
      include: { partner_role: { select: { role_type_code: true } } },
    });
    if (partner === null) {
      await tx.partner.create({
        data: {
          partner_code: code,
          partner_name: name,
          erp_partner_code: code,
          is_active: !isCancel(row),
          partner_role: { create: roles.map((role_type_code) => ({ role_type_code })) },
        },
      });
      return;
    }

    const held = new Set(partner.partner_role.map((r) => r.role_type_code));
    const added = roles.filter((role) => !held.has(role));
    const removed = ERP_ROLES.filter((role) => held.has(role) && !roles.includes(role));
    const changed =
      partner.partner_name !== name ||
      partner.erp_partner_code !== code ||
      (isCancel(row) && partner.is_active);
    if (!changed && added.length === 0 && removed.length === 0) return;

    if (removed.length > 0) {
      await tx.partner_role.deleteMany({
        where: { partner_id: partner.partner_id, role_type_code: { in: removed } },
      });
    }
    if (added.length > 0) {
      await tx.partner_role.createMany({
        data: added.map((role_type_code) => ({ partner_id: partner.partner_id, role_type_code })),
      });
    }
    // 역할만 바뀌어도 거래처의 판을 올린다 — 화면의 역할 저장이 거래처 ETag 로 묶여 있다.
    await tx.partner.update({
      where: { partner_id: partner.partner_id },
      data: {
        partner_name: name,
        erp_partner_code: code,
        // 사용 여부는 MES 도 고친다 — ERP 가 취소했을 때만 끈다.
        ...(isCancel(row) ? { is_active: false } : {}),
        updated_by: null,
        version_no: { increment: 1 },
      },
    });
  },
};

/** ERP 가 정하는 역할. 이 밖의 역할(폐기·외주·기타)은 MES 몫이다. */
const ERP_ROLES = ['SUPPLIER', 'CUSTOMER'];

/** BP_TYPE — S 매입처 · C 매출처 · CS 양쪽 · * 기타 매출처 · T 세무 사업장(역할 없음). */
function rolesOf(type: string): string[] {
  switch (type) {
    case 'S':
      return ['SUPPLIER'];
    case 'C':
    case '*':
      return ['CUSTOMER'];
    case 'CS':
      return ['SUPPLIER', 'CUSTOMER'];
    case 'T':
      return [];
    default:
      throw new Error(`모르는 거래처 유형 ${type}`);
  }
}
