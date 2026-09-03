/**
 * 송신 항목 다섯. **앱이 소유한다** — 고객이 늘리거나 지우지 않는다.
 *
 * 근거는 요구사항명세 QA §3.2 다 — 「송신 = 생산 실적(**필수**·개발품 제외) · G/R
 * (IQC 합격 직후 건별) · 출하(PGI) · 반품 · 실사조정. 송신은 항목별 선택(on/off).
 * **검사 결과 비연계**」.
 *
 * ⛔ 「검사 결과」는 이 목록에 **넣지 않는다.** 계약이 그 이유를 적었다 — 「연계하지
 *   않기로 확정돼 이 목록에 «나타나지 않는다» — 꺼진 채로도 보이지 않는다」. 값으로
 *   두고 끄면 누군가 켤 수 있다.
 *
 * ⛔ `locked` 를 «기본값»이 아니라 구조로 둔다. 설계가 그렇게 정했다 — 「필수와 비연계를
 *   기본값이 아니라 구조로 표현했다(§9-1). 생산 실적은 locked 가 참이라 **서버가 거부**
 *   한다」. 기본값이면 누군가 끌 수 있다.
 *
 * ⚠ `lockReason` 에 **확정 번호**를 담는다. 공유계약이 요구했다 — 「생산 실적 송신은
 *   필수입니다」보다 「생산 실적 송신은 필수입니다(2026-07-04 확정 QA #35)」가 낫다.
 *   현장·고객이 「왜 못 바꾸나」를 물을 때 추적 가능한 근거가 화면에 있어야 재확인 요청이
 *   정상 경로로 간다.
 */
export interface OutboundItem {
  code: string;
  name: string;
  locked: boolean;
  lockReason?: string;
  sendTimingNote?: string;
}

export const OUTBOUND_ITEMS: readonly OutboundItem[] = [
  {
    code: 'PRODUCTION_RESULT',
    name: '생산 실적',
    locked: true,
    lockReason: '생산 실적 송신은 필수입니다 (2026-07-04 확정 QA #35). 개발품은 품목 마스터에서 제외합니다.',
  },
  {
    code: 'GOODS_RECEIPT',
    name: '입고 (G/R)',
    locked: false,
    sendTimingNote: 'IQC 합격 직후 건별로 즉시 보냅니다 (QA #1).',
  },
  { code: 'SHIPMENT_PGI', name: '출하 (PGI)', locked: false },
  { code: 'RETURN', name: '반품', locked: false },
  { code: 'STOCK_ADJUSTMENT', name: '실사 조정', locked: false },
];

export const OUTBOUND_ITEM_CODES: ReadonlySet<string> = new Set(
  OUTBOUND_ITEMS.map((item) => item.code),
);
