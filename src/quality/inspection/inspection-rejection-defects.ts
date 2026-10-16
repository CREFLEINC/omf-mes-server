import { ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService } from '../defect/defect-record-write.service';
import type { InspectionResultCreate } from './inspection-result-write-input';

const IQC = 'IQC';
const REJECTED = 'REJECTED';

/**
 * IQC 불합격 사유(omf-all-around#106 · 장부 P-39) — 확정으로 태어나는 IQC 불합격은 본문 `defects` 가
 * 1줄 이상이어야 한다(`:confirm` 의 `assertRejectionRecorded` 와 같은 규칙 · 2026-10-16 결정).
 * ⛔ 거부는 채번 «앞»이다 — 400 이 될 저장에 번호를 태우지 않는다.
 */
export async function prepareRejectionDefects(
  prisma: PrismaService,
  defects: DefectRecordWriteService,
  body: Pick<InspectionResultCreate, 'inspectionRequestId' | 'overallJudgmentCode' | 'uomId' | 'defects'>,
  bornConfirmed: boolean,
) {
  const rows = body.defects ?? [];
  const judgedRejected = bornConfirmed && body.overallJudgmentCode === REJECTED;
  if (rows.length === 0 && !judgedRejected) return null;
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: BigInt(body.inspectionRequestId) },
    select: { inspection_type_code: true, lot_id: true, work_order_id: true },
  });
  const isIqc = request?.inspection_type_code === IQC;
  if (rows.length > 0 && !isIqc) {
    throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 IQC 검사 결과에만 함께 보낼 수 있습니다.'));
  }
  if (rows.length === 0) {
    if (isIqc) throw one(field('defects', ERROR_CODE.REQUIRED, '불합격이면 불량 코드와 사유를 함께 보내야 합니다.'));
    return null;
  }
  return {
    prepared: await defects.prepareInspectionDefects(rows, body.uomId),
    target: { lotId: request?.lot_id ?? null, workOrderId: request?.work_order_id ?? null },
  };
}
