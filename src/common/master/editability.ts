/**
 * 계약 `Editability` — 「코드 필드 수정 가능 여부」. 공유계약 `B-4`.
 * ⛔ 화면이 따로 세면 화면마다 다르게 구현된다(계약이 그 이유를 적었다).
 */
export interface Editability {
  codeEditable: boolean;
  reason:
    | 'EDITABLE'
    | 'REFERENCED'
    | 'NOT_COUNTABLE'
    | 'RECEIVED_FROM_ERP'
    // 코드가 라벨로 발행돼 현장에 물리적으로 나가 있다 — 참조가 0이어도 잠근다(계약).
    | 'LABEL_ISSUED'
    | 'SYSTEM_OWNED';
  referenceCount: number | null;
}
