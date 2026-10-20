/**
 * ⭐⭐ **입하 예정 라인 목록이 계약 사본에 없음을 지킨다**(장부 P-77 · #741).
 *
 * `GET /logistics/purchase-order-lines` 는 사본에 없어 `@Contract` 를 달 수 없다 — 그래서 인증·질의 검증을
 * 컨트롤러가 직접 한다(`purchase-order-line-list.controller.ts`). 정본이 이 경로를 실어 오면
 * 여기가 빨개진다 → `@Contract` 를 달고 수동 인증·검증을 지운다(가드로 옮긴다).
 *
 * ⭐ 지우는 조건 — 정본에 경로가 실려 와 P-77 을 닫을 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/logistics-01자재창고.json');

describe('계약 사본 — 입하 예정 라인 목록 선행 (P-77)', () => {
  it('⛔ 사본에 /logistics/purchase-order-lines 가 아직 없다 — 실려 오면 수동 인증을 가드로 옮긴다', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { paths: Record<string, unknown> };
    expect(Object.keys(contract.paths)).not.toContain('/logistics/purchase-order-lines');
  });
});
