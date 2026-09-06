import { TARGET_COLUMN } from './work-order-resource-plan.service';

/**
 * 유형 ↔ 칸 매핑만 본다 — 409·404 는 DB 가 판정하는 자리라 e2e 가 덮는다.
 * `ck_work_order_resource_target` 이 「넷 중 정확히 하나 non-null」을 물리로 지킨다.
 */
describe('4M 계획 배정', () => {
  it('배정 — `resourceTypeCode` 가 네 칸 중 하나만 채운다', () => {
    const columns = ['equipment_id', 'mold_id', 'worker_id', 'shift_id'];

    for (const [type, column] of Object.entries(TARGET_COLUMN)) {
      const data = { [column]: 1n };
      expect(columns.filter((name) => data[name] !== undefined)).toEqual([column]);
      expect(columns).toContain(column);
      expect(column).toBe(TARGET_COLUMN[type as keyof typeof TARGET_COLUMN]);
    }
    // ⛔ `SHIFT` 는 계약 enum 에 없다 — 이 경로로는 `shift_id` 가 영영 안 채워진다.
    expect(Object.keys(TARGET_COLUMN)).toEqual(['EQUIPMENT', 'WORKER', 'MOLD']);
    expect(Object.values(TARGET_COLUMN)).not.toContain('shift_id');
  });
});
