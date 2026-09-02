/**
 * 계약 `Editability` — 「코드 필드 수정 가능 여부」. 공유계약 `B-4`.
 * ⛔ 화면이 따로 세면 화면마다 다르게 구현된다(계약이 그 이유를 적었다).
 */
export interface Editability {
  codeEditable: boolean;
  reason: 'EDITABLE' | 'REFERENCED' | 'NOT_COUNTABLE' | 'RECEIVED_FROM_ERP' | 'SYSTEM_OWNED';
  referenceCount: number | null;
}
