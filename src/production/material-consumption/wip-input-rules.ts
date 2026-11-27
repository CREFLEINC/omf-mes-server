/**
 * 반제품 투입의 「바로 앞 공정」 판정(피처 016 R-3 · FR-009) — 순수 함수.
 *
 * 투입 W/O 의 Routing 에서 투입 공정보다 순번이 작은 것 중 가장 큰 공정이 «바로 앞» 공정이다. 그 공정의
 * **공정 마스터**가 반제품을 만든 공정의 공정 마스터와 같아야 한다 — Routing·순번이 아니라 공정 마스터로 비교해
 * 다른 Rev·다른 생산계획에서 남은 같은 앞 공정 반제품도 받는다. 앞 공정이 없으면(첫 공정 W/O) 반제품을 받지 않는다.
 * 건너뛴 공정(10 의 반제품을 30 에)은 바로 앞이 아니라 받지 않는다.
 */
export function isPreviousOperation(
  routingOperations: readonly { operation_seq: number; process_id: bigint }[],
  inputSeq: number,
  producedProcessId: bigint,
): boolean {
  const before = routingOperations.filter((operation) => operation.operation_seq < inputSeq);
  if (before.length === 0) return false;
  const previous = before.reduce((a, b) => (b.operation_seq > a.operation_seq ? b : a));
  return previous.process_id === producedProcessId;
}
