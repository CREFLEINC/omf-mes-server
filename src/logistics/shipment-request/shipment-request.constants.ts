/**
 * 출하작업지시 편성(I-22 PR ⑤)이 쓰는 상수. ⛔ `SHIPMENT_REQUEST_LINE`(예약의 원천 유형)은
 * 여기 없다 — `shipment-progress.ts` 가 「그 값의 유일한 자리」다. 두 벌이 되면 갈린다.
 */

/**
 * 계약이 `x-no-code-key` 로 닫은 칸인데 물리는 `NOT NULL` 이다 — **넣는 값**의 정본이다.
 * ⚠ 응답의 `statusCode` 는 저장값이 아니라 `shipment-request-view.ts` 의 같은 상수다(③b).
 * 둘이 갈리면 「저장은 됐는데 응답이 다른」 자리가 생기므로 e2e W-19 가 둘을 함께 본다.
 */
export const SHIPMENT_REQUEST_REGISTERED = 'REGISTERED';

/** `numbering_rule.document_type_code`. 접두어 `SR` 은 `numbering.service.ts` 가 갖는다(PR ①). */
export const SHIPMENT_REQUEST_DOCUMENT_TYPE = 'SHIPMENT_REQUEST';

/** `timeSlotCode` 의 `x-code-key` 가 가리키는 코드 그룹 — 시드 3값(`MORNING`·`AFTERNOON`·`NIGHT`). */
export const SHIPMENT_TIME_SLOT_GROUP = 'SHIPMENT_TIME_SLOT';

/** 계약에 `maxLength` 가 없다 — 물리 `varchar(200)` 를 앞당기지 않으면 초과가 **500** 이다. */
export const CUSTOMER_LOT_REQUIREMENT_MAX = 200;
