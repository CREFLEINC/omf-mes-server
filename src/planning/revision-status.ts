/**
 * 개정(Rev) 상태. Routing 과 BOM 이 **같은 축을 쓴다** — 시드 그룹 이름이 그대로
 * `REVISION_STATUS` 이고, 계약의 `Routing.statusCode`·`Bom.statusCode` 가 토씨까지 같은
 * `x-internal-note` 를 달고 있다(둘 다 `omf-mes#259`).
 *
 * 설계 결정 07 이 「작성중·확정·폐기」 셋으로 확정했고 시드에 세 값이 있다 — 수가 같고
 * 짝이 하나뿐이라 매핑에 재량이 없다.
 *
 * ⚠ 확정의 코드 문자열이 `ACTIVE` 다. 계약이 그 이름을 되돌리라 적어 두었다 —
 * 「결정 07 이 확정한 뜻 중 어느 것도 아니다. 공유계약 `G-32` 가 설비 자산 상태에서 같은
 * 결함을 잡아 `ACTIVE → IN_SERVICE·DISPOSED` 로 고쳤다」. 이름이 정해지면 **여기 한 줄만**
 * 바꾸면 되도록 상수로 둔다. 되돌림 §S-1.
 */
export const REVISION_STATUS = {
  DRAFT: 'DRAFT',
  CONFIRMED: 'ACTIVE',
  OBSOLETE: 'OBSOLETE',
} as const;
