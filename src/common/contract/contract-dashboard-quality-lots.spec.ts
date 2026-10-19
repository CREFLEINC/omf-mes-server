/**
 * ⭐⭐ **품질 종합 상태별 LOT 목록이 계약 사본에 없음을 지킨다**(장부 P-58 · omf-all-around#118).
 *
 * `GET /app/dashboard-quality-lots` 는 사본에 없어 `@Contract` 를 달 수 없다 — 그래서 인증·권한·질의 검증을
 * 컨트롤러가 가드와 같은 함수로 직접 한다(`dashboard-quality-lots.controller.ts`). 정본이 이 경로를 실어 오면
 * 여기가 빨개진다 → `@Contract` 를 달고 수동 인증·검증을 지운다(가드로 옮긴다).
 *
 * ⭐ 지우는 조건 — 정본에 경로가 실려 와 P-58 을 닫을 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/app-공통.json');

describe('계약 사본 — 품질 종합 상태별 LOT 목록 선행 (P-58)', () => {
  it('⛔ 사본에 /app/dashboard-quality-lots 가 아직 없다 — 실려 오면 수동 인증을 가드로 옮긴다', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { paths: Record<string, unknown> };
    expect(Object.keys(contract.paths)).not.toContain('/app/dashboard-quality-lots');
  });
});
