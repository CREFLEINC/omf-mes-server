/**
 * 계약 `app-공통.json` `#/components/schemas/ErrorItem`·`ErrorResponse` 와 동형.
 * 계약이 정본이므로 여기서 필드를 늘리거나 줄이지 않는다.
 */

/** 한 필드의 문제는 인라인, 화면 수준 문제는 배너. 근거: 공유계약 G-1 */
export type ErrorScope = 'field' | 'screen';

export interface ErrorItem {
  scope: ErrorScope;
  /** scope=field 일 때 대상 프로퍼티명 */
  field?: string;
  /** 계약이 값 목록을 「등」으로 열어 두었다 — union 으로 닫지 않는다 */
  code: string;
  /** code=UNIQUE_VIOLATION 일 때 어느 유일키 범위에서 중복인지. 근거: 공유계약 A-1 */
  uniqueScope?: string[];
  message: string;
}

export interface ErrorResponse {
  errors: ErrorItem[];
}
