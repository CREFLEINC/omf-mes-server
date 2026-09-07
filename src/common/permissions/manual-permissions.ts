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
  // 툴도 같다 — 도출표에 :deactivate·:dispose 만 들어왔다. 재개는 중지의 짝이다.
  'POST /mdm/molds/{moldId}:activate': ['W-05-13'],
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

  // 같은 화면의 역할 탭. §3-1 이 「역할 추가」·「저장」·「사용 중지」만 적어 목록·수정·전이가
  // 도출표에 안 들어왔다. 넷 다 이 화면이 소유한 자원의 같은 자리다.
  'GET /app/roles': ['W-CO-02'],
  'PUT /app/roles/{roleId}': ['W-CO-02'],
  // LOT 수정 — 요구서 §3 이 「등록·라벨발행」만 액션으로 적어 수정이 도출표에서 빠졌다.
  // 만드는 화면이 고치는 것이 자연스럽다(M-01-02 자재LOT 스캔등록 · P-01-01 LOT 등록).
  'PUT /trace/lots/{lotId}': ['M-01-02', 'P-01-01'],
  // 공지 — 요구서 §3 이 「작성·확인·닫기」만 액션으로 적어 게시·종료·수정·확인현황이
  // 도출표에서 빠졌다. 셋 다 W-CO-04(공지 관리)가 부르는 «관리자» 동작이고, 확인 현황도
  // 계약이 「확인을 요구한 공지에서만 «관리자»가 본다」로 적었다.
  'PUT /app/notices/{noticeId}': ['W-CO-04'],
  'POST /app/notices/{noticeId}:publish': ['W-CO-04'],
  'POST /app/notices/{noticeId}:close': ['W-CO-04'],
  'GET /app/notices/{noticeId}/acknowledgements': ['W-CO-04'],
  'POST /app/roles/{roleId}:activate': ['W-CO-02'],
  'POST /app/roles/{roleId}:deactivate': ['W-CO-02'],
  'PUT /app/roles/{roleId}/permissions': ['W-CO-02'],
  'PUT /app/users/{appUserId}': ['W-CO-02'],
  'POST /app/users/{appUserId}:activate': ['W-CO-02'],
  'POST /app/users/{appUserId}:deactivate': ['W-CO-02'],
  'PUT /app/users/{appUserId}/roles': ['W-CO-02'],
  'PUT /app/users/{appUserId}/data-scopes': ['W-CO-02'],

  // `W-06-01` Routing 등록·관리 — §3-2 가 「신규 Rev 발행」·「저장」·「확정」·「폐기」를
  // 적어 헤더 수정과 기본 Rev 지정이 도출표에 안 들어왔다. 셋 다 이 화면의 같은 자리다.
  'PUT /planning/routings/{routingId}': ['W-06-01'],
  'POST /planning/routings/{routingId}:set-default': ['W-06-01'],
  'PUT /planning/routings/{routingId}/operations': ['W-06-01'],
  'PUT /planning/routings/{routingId}/operation-dependencies': ['W-06-01'],
  'POST /planning/routings/{routingId}:confirm': ['W-06-01'],
  'POST /planning/routings/{routingId}:obsolete': ['W-06-01'],
  'POST /planning/routings/{routingId}:new-revision': ['W-06-01'],

  // `W-06-05` 수신본 확장속성 편집 — §3-6 이 「구성품 확장 열 편집」으로 이 경로를 적었는데
  // 요구서가 `.../components/{id}` 로, 계약이 `.../components/{bomComponentId}` 로 써서
  // 도출기의 「계약에 실재하는 것만 남긴다」 걸러내기에 떨어졌다(실측).
  'PUT /planning/boms/{bomId}/components/{bomComponentId}': ['W-06-05'],

  // `W-02-02` W/O 전개·편성 — 계획 수정. 도출표는 화면 «액션»만 긁어 「계획 추가·삭제」만
  // 들어왔고 수정이 빠졌다(`W-02-02` §7 DS 매핑 「계획 편집 표 — 편집 그리드」 + §3 ②
  // 행별 라인 Select 근거 — I-24.md R-13).
  'PUT /planning/production-plans/{productionPlanId}': ['W-02-02'],

  // `W-06-10` 연계 동기화 현황·실패 재처리 — 계약 x-internal-note 가 「소관 = W-06-10
  // (공유계약 B-4-1 ④ · 중복 구현 금지)」라 직접 적었다. `W-06-10` §5-1 액션 8건에 이
  // 액션이 «없다» — 잠정 등록이다(I-24.md R-13). 부르는 화면이 오늘 0건이어도 가드가
  // 등록을 요구한다(미등록이면 500 · 선례 `POST /production/material-returns`).
  'POST /planning/production-orders/{productionOrderId}:resync': ['W-06-10'],

  // `W-06-03` 불량·원인코드 2계층 마스터 — §3-4 가 「대분류 추가」·「상세 추가」만 적어
  // 수정·활성 전이와 원인코드 목록이 도출표에 안 들어왔다. 한 화면의 두 탭이다.
  'GET /quality/cause-codes': ['W-06-03'],
  'PUT /quality/defect-codes/{defectCodeId}': ['W-06-03'],
  'POST /quality/defect-codes/{defectCodeId}:activate': ['W-06-03'],
  'POST /quality/defect-codes/{defectCodeId}:deactivate': ['W-06-03'],
  'PUT /quality/cause-codes/{causeCodeId}': ['W-06-03'],
  'POST /quality/cause-codes/{causeCodeId}:activate': ['W-06-03'],
  'POST /quality/cause-codes/{causeCodeId}:deactivate': ['W-06-03'],

  // `W-06-02` 검사기준 등록 — §3-3 이 「기준 추가」·「승인」만 적어 수정·활성 전이가
  // 도출표에 안 들어왔다. 넷 다 이 화면이 소유한 자원의 같은 자리다.
  'PUT /quality/inspection-plans/{inspectionPlanId}': ['W-06-02'],
  'POST /quality/inspection-plans/{inspectionPlanId}:approve': ['W-06-02'],
  'POST /quality/inspection-plans/{inspectionPlanId}:activate': ['W-06-02'],
  'POST /quality/inspection-plans/{inspectionPlanId}:deactivate': ['W-06-02'],
  'PUT /quality/inspection-plan-versions/{inspectionPlanVersionId}': ['W-06-02'],
  'PUT /quality/inspection-plan-versions/{inspectionPlanVersionId}/items': ['W-06-02'],
  'POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:confirm': ['W-06-02'],
  'POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:obsolete': ['W-06-02'],
  'POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:new-revision': ['W-06-02'],

  // `W-06-14` 적치 규칙 마스터 — §3 이 「규칙 추가」만 적어 수정·활성 전이가 도출표에
  // 안 들어왔다. 셋 다 이 화면이 소유한 자원의 같은 자리다.
  'PUT /logistics/putaway-rules/{putawayRuleId}': ['W-06-14'],
  'POST /logistics/putaway-rules/{putawayRuleId}:activate': ['W-06-14'],
  'POST /logistics/putaway-rules/{putawayRuleId}:deactivate': ['W-06-14'],

  // `M-01-05` 적치·입고 완료 — ⭐ 도출표에 «이미 있는» 키에 화면을 더하는 둘째 자리다
  // (`GET /app/users` 선례). 도출표는 제품 입고(`M-04-04`)만 적었는데 자재 적치를 소유한
  // 화면은 `M-01-05` 다(§5-7 액션 [적치 완료]) — 없으면 물류담당이 403 을 받는다.
  'POST /logistics/putaway-tasks/{putawayTaskId}:complete': ['M-01-05'],
  // `M-01-07` 임시 위치 적재 — 계약이 403 을 선언했는데 도출표에 없다(미등록이면 500 ·
  // `permission.guard.ts:47-53`). ⛔ `M-04-04` 를 넣지 않는다 — 그 화면 §5-6 이
  // 「임시 위치 적재는 `M-01-07` 이 자재 전용이라 제품용 경로가 없다」라 적었다.
  'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary': ['M-01-07'],

  // `W-06-09` ERP-MES I/F 연계정의 관리 — §3 이 「정의 추가」만 적어 수정·활성 전이·연결
  // 시험이 도출표에 안 들어왔다. 넷 다 이 화면이 소유한 자원의 같은 자리다.
  'PUT /integration/interface-definitions/{interfaceDefinitionId}': ['W-06-09'],
  'POST /integration/interface-definitions/{interfaceDefinitionId}:activate': ['W-06-09'],
  'POST /integration/interface-definitions/{interfaceDefinitionId}:deactivate': ['W-06-09'],
  'POST /integration/interface-definitions/{interfaceDefinitionId}:test-connection': ['W-06-09'],

  // `W-06-10` 연계 동기화 현황·실패 재처리 — §3 이 「재처리(선택 일괄)」만 적어 상세와
  // 단건 재처리가 도출표에 안 들어왔다. 셋 다 한 화면의 같은 자리다.
  'GET /integration/messages/{integrationMessageId}': ['W-06-10'],
  'POST /integration/messages/{integrationMessageId}:retry': ['W-06-10'],

  // `W-06-15` 결재선 정의 — 그 화면이 결재선·결재단계의 마스터를 소유한다(§0 범위:
  // 「결재선 **정의**(`approval_route` + `approval_route_step`)만」). 도출표는 요구서 §3 의
  // 화면 «액션»만 긁어 등록(POST)만 들어왔고, 수정·단계 치환·활성 전이가 빠졌다 —
  // 요구서 §3-1 이 네 액션을 이 경로들에 직접 짝지었다(결재선 수정 / 단계 추가·삭제·재배치 /
  // 사용·사용 안 함).
  'PUT /app/approval-routes/{approvalRouteId}': ['W-06-15'],
  'PUT /app/approval-routes/{approvalRouteId}/steps': ['W-06-15'],
  'POST /app/approval-routes/{approvalRouteId}:activate': ['W-06-15'],
  'POST /app/approval-routes/{approvalRouteId}:deactivate': ['W-06-15'],

  // `W-01-11` 신규 P/O 등록 — 그 화면이 P/O 헤더·라인이라는 «자원의» 마스터를 소유한다
  // (§0 범위: 「초과 입하분의 사후 P/O 등록」). 도출표는 화면 «액션»만 긁어 등록(POST)만
  // 들어왔고 헤더 수정·라인 치환·승인 요청이 빠졌다.
  // ⚠ 근거는 «자원 소유» 하나로 통일한다(재수립 R-9 · uiux 7-(1)) — §5-1 의 「라인 추가·
  //   삭제」는 등록 폼 «안»의 행위라 `POST` 본문으로 가고 이 경로들이 아니다.
  'PUT /logistics/purchase-orders/{purchaseOrderId}': ['W-01-11'],
  'PUT /logistics/purchase-orders/{purchaseOrderId}/lines': ['W-01-11'],
  'POST /logistics/purchase-orders/{purchaseOrderId}:request-approval': ['W-01-11'],

  // `W-01-06`·`W-04-10` 폐기 요청 — 부르는 화면이 실제로 0건이나 `PermissionGuard` 가 등록을
  // 요구한다(미등록이면 500). 소유자를 폐기 두 화면으로 둔다 — 두 화면의 §3 액션표에 라인
  // 편집이 없어(「승인 요청」·「기타출고 처리」뿐) 도출표에 치환이 안 들어왔다.
  // ⚠ `M-01-09` §8 #1 이 「⛔ 라인 치환은 쓸 수 없다」라 적었다(I-4.md §6-1 · R-8 · 문의 030).
  'PUT /logistics/goods-issues/{goodsIssueId}/lines': ['W-01-06', 'W-04-10'],

  // `M-01-01` 입하 등록 — 도출표에 POST 만 들어왔다(§3 이 등록 액션만 적었다).
  // ⚠ 두 PUT 을 부르는 화면이 01 도메인 26장에 «없다»(문의 026) — 화면이 정해지기 전까지
  //   등록 화면으로 잠정 등록한다. 미등록이면 `PermissionGuard` 가 던져 500 이 된다.
  'PUT /logistics/inbound-receipts/{inboundReceiptId}': ['M-01-01'],
  'PUT /logistics/inbound-receipts/{inboundReceiptId}/lines': ['M-01-01'],

  // `M-01-08` 자재 출고 피킹 — `M-01-08` §5-8 의 액션 [피킹] — 요구서 §3 이 하위 자원 액션을
  // 안 적어 도출되지 않는다.
  'POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick': ['M-01-08'],

  // `M-01-06` 입하 오류 등록 — 그 화면이 이 자원의 유일한 소유자다(계약 description 근거).
  'POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances': ['M-01-06'],

  // 설계 미정 — 문의 050. 계약이 소유 화면을 비워 두었다(2026-08-26). 회신이 오면 이 한
  // 줄을 그 화면으로 바꾼다. 선례 `PUT /logistics/goods-issues/{id}/lines`·
  // `PUT /logistics/inbound-receipts/{id}`(부르는 화면이 0건이어도 가드가 등록을 요구한다 · I-10 R-10 넷째).
  'POST /production/material-returns': ['P-02-03'],

  // `P-02-01` 작업 시작 — 그 화면이 세션 작업자 목록을 소유한다(계약 `GET …/workers` 근거 =
  // `P-02-01` §5 · §5-A 가 `work_session_worker` 를 「작업자 — 사번 귀속 — REQ-PR-0023」으로
  // 자기 표에 실었다). `plan-api.md` 972행이 이 둘을 「S15 · 등록이 필요한 오퍼레이션」으로
  // 이미 셌다 — 도출표에 없고 계약이 403 을 선언해 미등록이면 `PermissionGuard` 가 500 을 낸다.
  // ⚠ 참여·이탈을 «부르는» 화면은 0건이다 — 화면이 정해지면 그때 옮긴다(설계 미정 — 문의 057).
  'POST /production/work-sessions/{workSessionId}/workers': ['P-02-01'],
  'POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave': ['P-02-01'],

  // `M-01-10` 재고이동·불량 반출 — 계약이 403 을 선언했는데 도출표에 없다(미등록이면 500 ·
  // `permission.guard.ts:47-53`). 계약 description 「도착 확정. 반출한 수량 이하만 받을 수
  // 있다. 근거: M-01-10 §5-6」 — 반출과 도착이 «한 화면의 두 단계」라 반출을 소유한 화면이
  // 도착도 소유한다.
  'POST /logistics/stock-transfers/{stockTransferId}:arrive': ['M-01-10'],

  // ⚠ 부르는 화면이 «0건»이다 — `M-01-10` §5-6 액션 7종에 라인 편집이 없다. 그래도 가드가
  // 등록을 요구한다(미등록이면 500 · 선례 `PUT /logistics/goods-issues/{id}/lines`). 소유자를
  // 이동 문서의 유일한 화면으로 둔다 — 잠정(설계 미정 · 문의 123).
  'PUT /logistics/stock-transfers/{stockTransferId}/lines': ['M-01-10'],
};
