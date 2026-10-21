import { Prisma } from '@prisma/client';

/**
 * 제품 검사표 「출하검사」 줄 ← 시리얼 OQC 기록(#68 `quality.oqc_serial_result` · 장부 P-101 · 이 연결은 P-102).
 * 그 시리얼의 OQC 기록이 있으면 출하검사 판정의 정본은 그 기록이다 — 검사표 조회·출력·승인 판단이 모두 그 판정을 쓰고,
 * POP 의 출하검사 입력은 막는다. 관리자 서명은 검사표 단계 줄(`source_code = 'OQC'`)에 남기되, 서명 뒤 OQC 재검으로
 * 기록이 바뀌면(`updated_at` 이 서명보다 늦으면) 서명이 풀린 것으로 본다 — 바뀐 판정에 다시 서명받게.
 */
export const SHIPMENT_STEP = 'SHIPMENT';

export const OQC_SELECT = {
  first_judgment_code: true,
  final_judgment_code: true,
  inspection_result_id: true,
  inspected_worker_id: true,
  inspected_at: true,
  updated_at: true,
  inspected_worker: { select: { worker_no: true, worker_name: true } },
} satisfies Prisma.oqc_serial_resultSelect;

export type OqcRecord = Prisma.oqc_serial_resultGetPayload<{ select: typeof OQC_SELECT }>;

export function oqcOf(client: Prisma.TransactionClient, serialNumberId: bigint): Promise<OqcRecord | null> {
  return client.oqc_serial_result.findUnique({ where: { serial_number_id: serialNumberId }, select: OQC_SELECT });
}

/** 출하검사 줄의 서명이 지금 OQC 기록에 대한 것인가. */
export function shipmentSigned(
  row: { source_code: string; signed_at: Date | null } | undefined,
  oqc: Pick<OqcRecord, 'updated_at'>,
): boolean {
  return row?.source_code === 'OQC' && row.signed_at !== null && row.signed_at >= oqc.updated_at;
}

/** 승인 판단에 쓸 단계 결과 — 출하검사는 OQC 기록이 있으면 그 최종 판정과 (유효한) 서명으로 바꾼다. */
export function effectiveResults(
  results: readonly { step_code: string; source_code: string; final_judgment_code: string; signed_at: Date | null }[],
  oqc: Pick<OqcRecord, 'final_judgment_code' | 'updated_at'> | null,
  stepCodes: readonly string[],
): { step_code: string; final_judgment_code: string; signed_at: Date | null }[] {
  if (oqc === null || !stepCodes.includes(SHIPMENT_STEP)) return [...results];
  const row = results.find((r) => r.step_code === SHIPMENT_STEP);
  return [
    ...results.filter((r) => r.step_code !== SHIPMENT_STEP),
    {
      step_code: SHIPMENT_STEP,
      final_judgment_code: oqc.final_judgment_code,
      signed_at: shipmentSigned(row, oqc) ? (row?.signed_at ?? null) : null,
    },
  ];
}
