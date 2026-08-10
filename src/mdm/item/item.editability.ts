import type { components } from '../../contracts/mdm';

type Editability = components['schemas']['Editability'];

/**
 * 품목은 **ERP 수신본**이라 원본 4열이 항상 잠긴다. 참조를 세지 않는다.
 *
 * 계약이 `#65`(수신본 식별 플래그 부재)를 미결로 적었지만, 이 API 에서는 판정이
 * 필요 없다 — `ItemUpdate` 가 원본 4열을 **아예 받지 않기** 때문이다. 보낼 방법이
 * 없으므로 런타임 판정 없이 구조로 막힌다(`forbidNonWhitelisted` 가 400).
 *
 * 참조를 세지 않으니 `mdm.item` 을 가리키는 39개 FK 에 인덱스를 달 이유도 없다 —
 * 창고(15)·로케이션(26)·부서(7)에 단 것은 전부 참조 건수를 세기 위한 것이었다.
 */
export function itemEditability(): Editability {
  return { codeEditable: false, reason: 'RECEIVED_FROM_ERP', referenceCount: null };
}
