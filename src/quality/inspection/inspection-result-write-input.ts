/**
 * 검사 결과 쓰기 두 경로(`POST`·`PUT`)의 **계약 본문 타입**과 본문 밖 컨텍스트.
 *
 * 쓰기 서비스에서 떼어 냈다(#337 ⓒ · #320 m-4) — 그 파일이 356줄로 `CLAUDE.md` 의 ~300 분리
 * 검토 신호를 넘겼고, 그중 55줄이 **판정 0줄짜리 타입 선언**이었다.
 * 선례 — `tool-usage-write-input.ts` · `document-issue-write-context.ts`.
 */

/** 계약 `InspectionMeasurementInput` — required 4 · 프로퍼티 8. */
export interface InspectionMeasurementInput {
  inspectionItemSpecId: number;
  sampleNo: number;
  numericValue?: number;
  textValue?: string;
  booleanValue?: boolean;
  judgmentCode: string;
  measuredAt: string;
  inspectionEquipmentId?: number;
}

/** 계약 `InspectionResultCreate` — required 8 · 프로퍼티 13. ⛔ 검사자·단말·번호·회차는 본문이 안 받는다. */
export interface InspectionResultCreate {
  inspectionRequestId: number;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  heldQty: number;
  uomId: number;
  overallJudgmentCode?: string;
  inspectedAt: string;
  statusCode: string;
  previousResultId?: number;
  reinspectionReasonCode?: string;
  measurements?: InspectionMeasurementInput[];
  remarks?: string;
}

/**
 * 계약 `InspectionResultUpdate` — required **0** · 프로퍼티 **8**.
 * ⛔ `statusCode` 가 없다 — `PUT` 으로 확정할 수 없다(확정 경로는 `POST statusCode=CONFIRMED` 와 `:confirm` 둘).
 * ⛔ `previousResultId`·`reinspectionReasonCode` 가 없다 — 회차 사슬은 못 고친다(B-10 「번복은 재검이지 수정이 아니다」).
 * ⚠ `[string,null]`·`[integer,null]` 형이 **하나도 없다** — 명시 null 로 «해제»하는 칸이 0 이라
 *   `optional()` 관행 중 **null 갈래를 쓰지 않는다**(§1-3).
 */
export interface InspectionResultUpdate {
  inspectedQty?: number;
  acceptedQty?: number;
  rejectedQty?: number;
  heldQty?: number;
  overallJudgmentCode?: string;
  inspectedAt?: string;
  measurements?: InspectionMeasurementInput[];
  remarks?: string;
}

/** 본문 밖에서 오는 것. `version`(If-Match)은 `POST` 에서 **선택**이고 `PUT` 에서 필수다. */
export interface InspectionResultWriteContext {
  workerNo: string | undefined;
  idempotencyKey: string;
  version: number | undefined;
  appUserId: number | undefined;
  terminalId: bigint | null;
}
