/**
 * 결정 — 통보 141. 계약이 `HandlingUnit.statusCode` 를 `x-no-code-key`(「코드 그룹을 세우지
 * 않는다」)로 닫았는데 컬럼은 NOT NULL 이고, 같은 계약의 `:pack` 이 「이미 확정된 포장은
 * 409 다」를 요구해 «확정 전/후»를 가릴 축이 필요하다. 값 목록이 오면 이 두 줄만 바꾼다.
 *
 * ⚠ 이 상수가 «전부»는 아니다 — 병합된 픽스처가 `'ACTIVE'` 를 쓴다(통보 164 ⓐ). 그래서
 *   목록 질의 `statusCode` 에는 값 검증을 걸지 않는다(없는 코드로 물으면 빈 목록이다).
 * ⛔ 되돌리는 전이가 0이다 — 해체 화면이 계약에 0건이다(통보 142).
 */
export const HU_STATUS_OPEN = 'OPEN'; // 등록됐고 아직 확정되지 않았다
export const HU_STATUS_PACKED = 'PACKED'; // `:pack` 이 닫았다 — 쓰는 곳은 PR ⑤ 다
