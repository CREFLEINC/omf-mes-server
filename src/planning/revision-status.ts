/**
 * 개정(Rev) 상태. Routing·BOM·검사기준 버전이 **같은 축을 쓴다** — 계약 그룹
 * `MASTER_VERSION_STATUS`(x-code-key `CD-MASTER-VERSION-STATUS`) 하나를 셋이 준용한다
 * (결정 07 · 사본 6d03a44). 시드 그룹 이름도 같다.
 *
 * 설계 결정 07 이 「작성중·확정·폐기」 셋으로 확정했고 시드에 세 값이 있다 — 수가 같고
 * 짝이 하나뿐이라 매핑에 재량이 없다. 확정의 문자열은 `ACTIVE` 였다가 6d03a44 가
 * `CONFIRMED` 로 확정했다(마이그레이션 20260904110000). 되돌림 §S-1.
 */
export const REVISION_STATUS = {
  DRAFT: 'DRAFT',
  CONFIRMED: 'CONFIRMED',
  OBSOLETE: 'OBSOLETE',
} as const;
