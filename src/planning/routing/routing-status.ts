/**
 * Routing Rev 상태. 시드 `REVISION_STATUS` 가 세 값을 담고 있고, 설계 결정 07 이
 * 「작성중·확정·폐기」 셋으로 확정했다 — 수가 같고 짝도 하나뿐이다.
 *
 * ⚠ `CONFIRMED` 의 코드 문자열이 `ACTIVE` 다. 계약이 그 이름을 되돌리라 적어 두었다 —
 * 「결정 07 이 확정한 뜻(작성중·확정·폐기) 중 어느 것도 아니다. 공유계약 `G-32` 가 설비
 * 자산 상태에서 같은 결함을 잡아 `ACTIVE → IN_SERVICE·DISPOSED` 로 고쳤다」.
 * 이름이 정해지면 **여기 한 줄만** 바꾸면 되도록 상수로 둔다. 되돌림 §S.
 */
export const ROUTING_STATUS = {
  DRAFT: 'DRAFT',
  CONFIRMED: 'ACTIVE',
  OBSOLETE: 'OBSOLETE',
} as const;
