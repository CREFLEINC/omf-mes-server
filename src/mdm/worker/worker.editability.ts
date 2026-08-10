import type { components } from '../../contracts/mdm';

type Editability = components['schemas']['Editability'];

/**
 * 작업자는 **테이블 전체가 ERP 수신본**이라 쓰기 경로 자체가 없다.
 *
 * 품목은 원본과 MES 확장이 한 행에 섞여 있어 `ItemUpdate` 가 원본을 빼는 방식으로
 * 막았지만, 작업자는 기본 정보 전부가 수신본이다 — 계약도 「행 단위 식별 플래그(#65)가
 * 없어도 판정에 모호함이 없다」고 적었다. MES 가 덧붙이는 것은 자격·인증뿐이고
 * 그것은 별도 경로다.
 */
export function workerEditability(): Editability {
  return { codeEditable: false, reason: 'RECEIVED_FROM_ERP', referenceCount: null };
}
