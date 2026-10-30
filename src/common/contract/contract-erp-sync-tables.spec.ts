/**
 * ⭐⭐ **ERP 받기 표별 상태·「지금 읽기」(장부 P-81)·ERP 창고(P-147)가 계약에 없음을 지킨다.**
 *
 * `GET /integration/erp-sync/tables`·`POST /integration/erp-sync/tables/{interfaceCode}:run`·`GET /integration/erp-sync/warehouses` 는
 * 계약에 없어 `@Contract` 를 달 수 없다 — 그래서 인증·권한을 컨트롤러가 가드와 같은 함수로 직접 한다(`erp-sync.controller.ts`).
 * 같은 접두어에서 계약에 있는 것은 통관번호 받아오기(P-143)뿐이다. 다른 경로가 계약에 실리면 여기가 빨개진다 → `@Contract` 를 달고
 * 수동 인증을 지운다(가드로 옮긴다).
 *
 * ⭐ 지우는 조건 — 세 경로를 모두 계약에 옮길 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACTS = join(__dirname, '../../../contracts');

describe('계약 — ERP 받기 표별 상태·지금 읽기·ERP 창고 선행 (P-81 · P-147)', () => {
  it('⛔ /integration/erp-sync 경로는 통관번호 받아오기 하나뿐이다 — 다른 것이 실리면 수동 인증을 가드로 옮긴다', () => {
    const paths = readdirSync(CONTRACTS)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => Object.keys((JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) as { paths?: object }).paths ?? {}));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('/integration/erp-sync'))).toEqual([
      '/integration/erp-sync/purchase-orders/{purchaseOrderId}/customs-clearances:fetch',
    ]);
  });
});
