/**
 * ⭐⭐ **대시보드 기간 조회가 계약보다 앞서 있음을 지킨다**(장부 P-59 · omf-all-around#118).
 *
 * `dateFrom`·`dateTo` 는 사본에 없다. 계약 검증 가드는 사본에 없는 질의를 통과시키므로 지금은
 * `dashboard-range.ts` 가 손으로 검증한다. 정본이 이 쿼리를 실어 오면 가드가 검증을 맡게 되고,
 * 응답 키·400 선언도 함께 대조해야 한다 — 그 순간을 놓치지 않게 여기가 빨개진다.
 *
 * ⭐ 지우는 조건 — 정본에 기간 쿼리가 실려 와 P-59 의 기간 조회 항목을 닫을 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/app-공통.json');

describe('계약 사본 — 대시보드 기간 조회 선행 (P-59)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<string, Record<string, { parameters?: { name?: string }[]; responses?: Record<string, unknown> }>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  const get = contract.paths['/app/dashboard-summary']?.get;

  it('⛔ 쿼리는 아직 baseDate · plantId 뿐이다 — 늘었으면 dashboard-range.ts 수동 검증을 가드로 넘긴다', () => {
    expect((get?.parameters ?? []).map((parameter) => parameter.name).sort()).toEqual(['baseDate', 'plantId']);
  });

  it('⛔ 응답에 400 이 없고 DashboardSummary 에 dateFrom·dateTo 가 없다 — 실려 오면 이름·모양을 대조한다', () => {
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(['200', '403']);
    const properties = Object.keys(contract.components.schemas.DashboardSummary?.properties ?? {});
    expect(properties).not.toContain('dateFrom');
    expect(properties).not.toContain('dateTo');
  });
});
