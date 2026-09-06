/**
 * 자재 출고요청 전표 상태의 **정본**. 값 목록은 계약 `MaterialIssueRequest.statusCode` 가
 * 지목한 `LOGISTICS_DOCUMENT_STATUS` 이고 시드가 4값(`REGISTERED`·`POSTED`·
 * `CANCEL_REQUESTED`·`CANCELLED`)을 시스템 소유로 갖는다(I-8.md §4-3).
 *
 * ⛔ 목록 질의 `statusCode` 는 이 값과 **대조하지 않는다** — 값이 늘 때 조회가 400 을 낸다.
 * `src/production/work-order/material-issue.ts` 가 같은 값을 복사해 갖는다(도메인 간
 * import 금지) — 둘이 어긋나지 않는 것을 e2e 가 못박는다.
 */
export const ISSUE_REQUEST_REGISTERED = 'REGISTERED';
