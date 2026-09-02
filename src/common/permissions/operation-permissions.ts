import { DERIVED_PERMISSIONS } from './derived-permissions';
import { MANUAL_PERMISSIONS } from './manual-permissions';

/**
 * 오퍼레이션 → 그것을 부를 수 있는 권한(그중 **하나**만 있으면 된다).
 *
 * 두 겹이다 — 설계 자료에서 «도출한 것»과 §3 이 짝지어 주지 않아 «근거를 적어 손으로
 * 채운 것». 둘을 갈라 두는 이유는 출처가 다르기 때문이다: 도출표는 설계가 갱신되면
 * 통째로 다시 만들고, 수동표는 사람이 근거를 대고 넣는다.
 */
export const OPERATION_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  ...DERIVED_PERMISSIONS,
  ...MANUAL_PERMISSIONS,
};
