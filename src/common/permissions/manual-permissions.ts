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
};
