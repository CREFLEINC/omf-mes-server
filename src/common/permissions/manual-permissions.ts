/**
 * 요구서 §3 이 짝지어 주지 않은 자리. **각 줄에 근거를 적는다.**
 *
 * §3 은 화면 «액션»을 적으므로 상세 조회·하위 자원·상태 전이가 빠진다. 그 자리를 여기
 * 채우되, 「그 화면이 그 자원의 마스터를 소유한다」가 근거일 때만 적는다 —
 * 지어내면 그것이 사실상의 인가 정책이 된다.
 *
 * ⛔ 도출표(`derived-permissions.ts`)와 겹치면 검사가 막는다. 겹치는 것은 도출이
 * 이미 답을 준 자리라 여기 있을 이유가 없다.
 */
export const MANUAL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  // `W-06-06` 공통코드·조직·작업자 마스터(다국어) — 그 화면이 이 넷의 마스터를 소유한다.
  // §3 이 목록·등록만 적고 상세·수정·활성 전이를 안 적었다.
  'PUT /mdm/code-groups/{codeGroupId}': ['W-06-06'],
  'POST /mdm/code-groups/{codeGroupId}:activate': ['W-06-06'],
  'POST /mdm/code-groups/{codeGroupId}:deactivate': ['W-06-06'],
  'PUT /mdm/code-values/{codeValueId}': ['W-06-06'],
  'POST /mdm/code-values/{codeValueId}:activate': ['W-06-06'],
  'POST /mdm/code-values/{codeValueId}:deactivate': ['W-06-06'],
  'POST /mdm/departments': ['W-06-06'],
  'PUT /mdm/departments/{departmentId}': ['W-06-06'],
  'POST /mdm/departments/{departmentId}:activate': ['W-06-06'],
  'POST /mdm/departments/{departmentId}:deactivate': ['W-06-06'],
  'PUT /mdm/workers/{workerId}/qualifications': ['W-06-06'],

  // `W-06-07` 물류 마스터 — §3 이 「창고 등록」만 적어 도출표에 `POST` 만 들어왔다.
  // 수정과 활성 전이는 같은 화면의 같은 자원이다.
  'PUT /mdm/warehouses/{warehouseId}': ['W-06-07'],
  'POST /mdm/warehouses/{warehouseId}:activate': ['W-06-07'],
  'POST /mdm/warehouses/{warehouseId}:deactivate': ['W-06-07'],
  'PUT /mdm/locations/{locationId}': ['W-06-07'],
  'POST /mdm/locations/{locationId}:activate': ['W-06-07'],
  'POST /mdm/locations/{locationId}:deactivate': ['W-06-07'],

  // `W-06-05` 품목 마스터(MES 확장 속성) — 도출표에 조회만 들어왔다(§3 이 좌측 목록만
  // 적었다). 편집이 그 화면의 본체다.
  'PUT /mdm/items/{itemId}': ['W-06-05'],
};
