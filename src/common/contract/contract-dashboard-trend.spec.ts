/**
 * ⭐⭐ **대시보드 생산 추이 값의 null 이 계약보다 앞서 있음을 지킨다**(장부 P-60 · omf-all-around#118).
 *
 * 서버는 실적 기록이 없는 날 `trend.points[].value = null` 을 낸다(사용자 결정 2026-10-19). 사본은 `number` 뿐이라
 * 대시보드 e2e 의 응답 검증이 이 칸만 `['number', 'null']` 로 보정한다. 정본이 null 을 실어 오면 여기가 빨개진다 →
 * e2e 보정을 지우고 P-60 을 닫는다.
 *
 * ⭐ 지우는 조건 — 정본에 null 이 실려 와 P-60 을 닫을 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/app-공통.json');

describe('계약 사본 — 대시보드 생산 추이 null 선행 (P-60)', () => {
  it('⛔ 사본의 trend.points[].value 는 아직 number 뿐이다 — 바뀌면 e2e 응답 검증 보정을 지운다', () => {
    type Schema = { type?: unknown; properties?: Record<string, Schema>; items?: Schema };
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { components: { schemas: Record<string, Schema> } };
    const trend = contract.components.schemas.DashboardSummary?.properties?.trend;
    expect(trend?.properties?.points?.items?.properties?.value?.type).toBe('number');
  });
});
