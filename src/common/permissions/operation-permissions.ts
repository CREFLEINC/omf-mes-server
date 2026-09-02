import { DERIVED_PERMISSIONS } from './derived-permissions';
import { MANUAL_PERMISSIONS } from './manual-permissions';

/**
 * 오퍼레이션 → 그것을 부를 수 있는 권한(그중 **하나**만 있으면 된다).
 *
 * 두 겹이다 — 설계 자료에서 «도출한 것»과 §3 이 짝지어 주지 않아 «근거를 적어 손으로
 * 채운 것». 둘을 갈라 두는 이유는 출처가 다르기 때문이다: 도출표는 설계가 갱신되면
 * 통째로 다시 만들고, 수동표는 사람이 근거를 대고 넣는다.
 *
 * ⛔ 두 표를 **합집합으로** 겹친다. 덮어쓰기(`{...A, ...B}`)면 수동표가 같은 키를 적는
 * 순간 도출된 화면들이 «조용히» 빠진다 — 그 화면 사용자가 403 을 받게 되고, 아무 검사도
 * 그것을 잡지 못한다. 실제로 걸린 자리는 `GET /app/users` 다: 도출표가 결재선·결재함
 * (`W-06-15`·`W-CO-09`)에서 그것을 부른다고 적었는데, 사용자 목록을 «소유»하는
 * `W-CO-02` 는 요구서 §3 이 화면 «액션»만 적어 도출되지 않는다. 셋 다 부를 수 있어야 한다.
 */
export const OPERATION_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [...new Set([...Object.keys(DERIVED_PERMISSIONS), ...Object.keys(MANUAL_PERMISSIONS)])].map(
    (key) => [
      key,
      [...new Set([...(DERIVED_PERMISSIONS[key] ?? []), ...(MANUAL_PERMISSIONS[key] ?? [])])].sort(),
    ],
  ),
);
