import type { components } from '../contracts/mdm';

export type Editability = components['schemas']['Editability'];

/**
 * 코드 필드를 지금 고쳐도 되는지에 대한 서버의 판정. 화면이 세지 않는다(공유계약 B-4).
 *
 * 참조가 전부 FK 로 세지는 마스터에만 쓴다 — 지금은 창고·로케이션이다. 나머지 두 사유는
 * 여기서 나오지 않는다: `RECEIVED_FROM_ERP` 는 ERP 수신본(품목·작업자), `NOT_COUNTABLE`
 * 은 FK 가 아니라 코드 문자열로 참조되는 코드값의 것이다. 그때는 이 함수를 쓰지 말고
 * 해당 마스터가 자기 판정을 만든다.
 */
export function toEditability(referenceCount: number): Editability {
  return referenceCount === 0
    ? { codeEditable: true, reason: 'EDITABLE', referenceCount: 0 }
    : { codeEditable: false, reason: 'REFERENCED', referenceCount };
}
