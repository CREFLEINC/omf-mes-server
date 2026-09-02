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
  'PUT /mdm/items/{itemId}/bu-item-maps': ['W-06-05'],
  'PUT /mdm/items/{itemId}/external-codes': ['W-06-05'],
  'PUT /mdm/items/{itemId}/uom-conversions': ['W-06-05'],

  // `W-05-12` 설비·그룹 마스터 — §5-1 이 「중지」만 적어 도출표에 :deactivate 만 들어왔다.
  // 재개는 그 짝이고, 같은 화면의 같은 자원이다.
  'POST /mdm/equipment-groups/{equipmentGroupId}:activate': ['W-05-12'],
  // 설비도 같다 — 도출표에 :deactivate·:dispose 만 들어왔다. 재개는 중지의 짝이다.
  'POST /mdm/equipments/{equipmentId}:activate': ['W-05-11', 'W-05-12'],

  // `W-CO-06` 단말 관리 — §3 이 「등록·토큰 발급·공정 구성」만 적어 수정과 중지가
  // 도출표에 안 들어왔다. 같은 화면의 같은 자원이다.
  'PUT /mdm/terminals/{terminalId}': ['W-CO-06'],
  'POST /mdm/terminals/{terminalId}:deactivate': ['W-CO-06'],

  // `W-06-08` 예비품 마스터 — §5 가 「등록·올리기」만 적어 나머지가 도출표에 안 들어왔다.
  // 수정·전이·설비매핑은 같은 화면의 같은 자원이다.
  'PUT /mdm/spare-parts/{sparePartId}': ['W-06-08'],
  'POST /mdm/spare-parts/{sparePartId}:activate': ['W-06-08'],
  'POST /mdm/spare-parts/{sparePartId}:deactivate': ['W-06-08'],
  'PUT /mdm/spare-parts/{sparePartId}/equipments': ['W-06-08'],

  // `W-06-06` 「거래처 역할」 탭 — §3 이 탭만 적어 저장이 도출표에 안 들어왔다.
  // 거래처 본체는 ERP 수신본이라 고칠 것이 역할뿐이고, 그것이 이 화면의 본체다.
  'PUT /mdm/partners/{partnerId}/roles': ['W-06-06'],

  // `W-05-09` 작업 캘린더 — §5-A 가 등록만 적어 수정·중지가 도출표에 안 들어왔다.
  'PUT /mdm/work-calendars/{workCalendarId}': ['W-05-09'],
  'POST /mdm/work-calendars/{workCalendarId}:deactivate': ['W-05-09'],

  // `W-CO-02` 사용자·역할·권한 관리 — ⭐ 도출표에 «이미 있는» 키에 화면을 더하는 첫 자리다.
  // 도출표는 결재선 정의·결재함(`W-06-15`·`W-CO-09`)이 사용자를 «고른다»고만 적었다.
  // 정작 이 목록을 소유한 화면이 빠져 있다 — 요구서 §3-1 이 화면 «액션»(추가·저장·중지)만
  // 적어 좌측 목록이 도출되지 않는다. 그래서 두 표는 합집합으로 겹친다.
  'GET /app/users': ['W-CO-02'],
};
