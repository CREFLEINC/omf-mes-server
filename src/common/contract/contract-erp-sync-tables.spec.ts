/**
 * ⭐⭐ **ERP 받기 표별 상태·「지금 읽기」가 계약 사본에 없음을 지킨다**(장부 P-81). 통관번호 받아오기(P-143)도 같은 접두어라 함께 지킨다.
 *
 * `GET /integration/erp-sync/tables`·`POST /integration/erp-sync/tables/{interfaceCode}:run` 은 사본에 없어
 * `@Contract` 를 달 수 없다 — 그래서 인증·권한을 컨트롤러가 가드와 같은 함수로 직접 한다(`erp-sync.controller.ts`).
 * 정본이 이 경로를 실어 오면 여기가 빨개진다 → `@Contract` 를 달고 수동 인증을 지운다(가드로 옮긴다).
 *
 * ⭐ 지우는 조건 — 정본에 경로가 실려 와 P-81 를 닫을 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACTS = join(__dirname, '../../../contracts');

describe('계약 사본 — ERP 받기 표별 상태·지금 읽기 선행 (P-81)', () => {
  it('⛔ 사본 어디에도 /integration/erp-sync 경로가 아직 없다 — 실려 오면 수동 인증을 가드로 옮긴다', () => {
    const paths = readdirSync(CONTRACTS)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => Object.keys((JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) as { paths?: object }).paths ?? {}));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('/integration/erp-sync'))).toEqual([]);
  });
});
