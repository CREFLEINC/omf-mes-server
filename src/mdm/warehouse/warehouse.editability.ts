import type { components } from '../../contracts/mdm';

export type Editability = components['schemas']['Editability'];

/**
 * 코드 필드를 지금 고쳐도 되는지에 대한 서버의 판정. 화면이 세지 않는다(공유계약 B-4).
 *
 * 창고는 MES 가 등록·수정하는 마스터라 `RECEIVED_FROM_ERP` 는 해당이 없고,
 * 참조가 전부 FK 라 `NOT_COUNTABLE` 도 해당이 없다 — 둘은 품목·작업자(ERP 수신본)와
 * 코드값(코드 문자열로만 참조됨)에서 쓰인다.
 */
export function toEditability(referenceCount: number): Editability {
  return referenceCount === 0
    ? { codeEditable: true, reason: 'EDITABLE', referenceCount: 0 }
    : { codeEditable: false, reason: 'REFERENCED', referenceCount };
}
