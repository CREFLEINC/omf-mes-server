import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DefectRecordWriteService,
  InspectionDefectInput,
  PreparedInspectionDefects,
} from '../defect/defect-record-write.service';
import type { InspectionResultCreate } from './inspection-result-write-input';

const IQC = 'IQC';
const REJECTED = 'REJECTED';

/**
 * IQC 불합격 사유(omf-all-around#106 · 장부 P-42) — 확정으로 태어나는 IQC 불합격은 본문 `defects` 가
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
  // 합격·보류로 태어나는 회차에는 불량 기록을 두지 않는다 — `:confirm` 과 같은 규칙(#121 · 장부 P-47).
  if (rows.length > 0 && bornConfirmed && body.overallJudgmentCode !== REJECTED) {
    throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 불합격 판정에만 함께 보낼 수 있습니다.'));
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

/**
 * `:confirm` 본문의 불합격 사유(omf-all-around#121 · 장부 P-47) — 트랜잭션 «밖»에서 검증한다.
 * `defects` 를 싣지 않으면 `null` — 이미 붙어 있는 불량 기록을 그대로 쓴다(옛 «등록 → 확정» 두 요청 경로).
 */
export async function prepareConfirmDefects(
  prisma: PrismaService,
  defects: DefectRecordWriteService,
  inspectionResultId: bigint,
  body: { overallJudgmentCode?: string; defects?: InspectionDefectInput[] },
): Promise<PreparedInspectionDefects | null> {
  if (body.defects === undefined) return null;
  const result = await prisma.inspection_result.findUnique({
    where: { inspection_result_id: inspectionResultId },
    select: { uom_id: true, overall_judgment_code: true, inspection_request: { select: { inspection_type_code: true } } },
  });
  // 없는 결과는 트랜잭션의 잠금이 404 로 답한다.
  if (result === null) return null;
  const isIqc = result.inspection_request.inspection_type_code === IQC;
  const isRejected = (body.overallJudgmentCode ?? result.overall_judgment_code) === REJECTED;
  if (body.defects.length === 0) {
    if (isIqc && isRejected) throw one(field('defects', ERROR_CODE.REQUIRED, '불합격이면 불량 코드와 사유를 함께 보내야 합니다.'));
    return null;
  }
  if (!isIqc) throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 IQC 검사 결과에만 함께 보낼 수 있습니다.'));
  if (!isRejected) throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 불합격으로 확정할 때만 보낼 수 있습니다.'));
  return defects.prepareInspectionDefects(body.defects, Number(result.uom_id));
}

/**
 * 확정 직전, 그 회차의 IQC 불량 기록을 확정 판정에 맞춘다(omf-all-around#121 · 장부 P-47).
 * - 불합격 + 본문 사유: 기존 기록을 지우고 본문 값으로 다시 쓴다 — 한 회차의 사유는 확정 시점 입력 1벌이다.
 * - 합격·보류: 확정 전에 붙었던 기록을 지운다 — 합격 회차에 불량이 남지 않는다.
 * - 불합격 + 사유 없음: 손대지 않는다(`assertRejectionRecorded` 가 기록을 요구한다).
 * ⛔ 확정과 같은 트랜잭션이다 — 확정이 실패하면 기록 변경도 함께 되돌려진다.
 */
export async function syncConfirmDefectsWithin(
  tx: Prisma.TransactionClient,
  defects: DefectRecordWriteService,
  input: {
    inspectionResultId: bigint;
    inspectionRequestId: bigint;
    judgment: string | undefined;
    prepared: PreparedInspectionDefects | null;
    detectedAt: Date;
    actor: { appUserId: number; workerId: bigint };
  },
): Promise<void> {
  const isRejected = input.judgment === REJECTED;
  if (isRejected && input.prepared === null) return;
  const request = await tx.inspection_request.findUnique({
    where: { inspection_request_id: input.inspectionRequestId },
    select: { inspection_type_code: true, lot_id: true, work_order_id: true },
  });
  if (request?.inspection_type_code !== IQC) return;
  // 밖에서 읽은 판정과 잠근 뒤의 판정이 갈린 경우 — 불합격이 아닌 확정에 사유를 남기지 않는다.
  if (input.prepared !== null && !isRejected) {
    throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 불합격으로 확정할 때만 보낼 수 있습니다.'));
  }
  await removeIqcDefectsWithin(tx, input.inspectionResultId);
  if (input.prepared === null) return;
  await defects.writeInspectionDefectsWithin(
    tx,
    input.prepared,
    {
      inspectionResultId: input.inspectionResultId,
      lotId: request.lot_id,
      workOrderId: request.work_order_id,
      detectedAt: input.detectedAt,
    },
    input.actor,
  );
}

/** ⛔ 수리 이력이 붙은 기록은 지우지 않는다 — FK(`NoAction`)가 500 으로 새기 전에 400 으로 막는다. */
async function removeIqcDefectsWithin(tx: Prisma.TransactionClient, inspectionResultId: bigint): Promise<void> {
  const rows = await tx.defect_record.findMany({
    where: { inspection_result_id: inspectionResultId, source_type_code: IQC },
    select: { defect_record_id: true },
  });
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.defect_record_id);
  const [repairs, executions] = await Promise.all([
    tx.repair_result.count({ where: { defect_record_id: { in: ids } } }),
    tx.repair_execution.count({ where: { defect_record_id: { in: ids } } }),
  ]);
  if (repairs + executions > 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '이 회차의 불량 기록에 수리 이력이 있어 사유를 바꿀 수 없습니다.' },
    ]);
  }
  await tx.defect_record.deleteMany({ where: { defect_record_id: { in: ids } } });
}
