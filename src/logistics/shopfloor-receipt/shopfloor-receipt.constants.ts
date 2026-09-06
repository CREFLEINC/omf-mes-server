/**
 * 생산창고 입고 전표 상태의 **정본**. 값 목록은 계약 `ShopfloorReceipt.statusCode` 가 지목한
 * `LOGISTICS_DOCUMENT_STATUS` 다(I-9.md §3-5).
 *
 * ⛔ `goods-issue.service.ts:34`(`POSTED`)가 export 하지 않으므로 여기 사본을 둔다 —
 * 도메인 간 import 금지(`material-issue-request.constants.ts` 와 같은 모양).
 * 이 전표는 원장을 영원히 지나지 않아 `POSTED` 로 못 옮긴다(I-9.md §3-5) — `RECEIPT_REGISTERED`
 * 만 쓰고 `ISSUE_POSTED` 는 이 출고 상태 게이트(PR ②)와 e2e 픽스처가 쓴다.
 */
export const RECEIPT_REGISTERED = 'REGISTERED';
export const ISSUE_POSTED = 'POSTED';
