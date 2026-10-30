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
const NO_REJECTION = '불량 내역은 불합격 수량이 있거나 불합격 판정일 때만 보낼 수 있습니다.';
const REJECTED = 'REJECTED';

/**
 * 불량 기록을 둘 수 있는 회차(omf-all-around#205) — 불합격 판정이거나, 판정과 관계없이 불합격 수량이 있다.
 * 불합격 수량이 합격판정개수 안이라 합격·보류로 확정되는 LOT 도 그 불량의 유형·사유를 남긴다.
 */
const keepsDefects = (judgment: string | null | undefined, rejectedQty: number | null | undefined): boolean =>
  judgment === REJECTED || Number(rejectedQty ?? 0) > 0;

/** 불량 수량 합계 = 불합격 수량(#205) — 불합격 수량이 있을 때만 맞춘다. 0 인 불합격 판정은 종전 그대로다. */
function assertDefectSum(rows: { defectQty: number }[], rejectedQty: number): void {
  if (rejectedQty <= 0 || rows.length === 0) return;
  const sum = rows.reduce((acc, row) => acc + Number(row.defectQty), 0);
  if (Math.abs(sum - rejectedQty) > 1e-6) {
    throw one(field('defects', ERROR_CODE.INVALID, `불량 수량 합계(${sum})가 불합격 수량(${rejectedQty})과 같아야 합니다.`));
  }
}

/**
 * IQC 불합격 사유(omf-all-around#106 · 장부 P-42) — 확정으로 태어나는 IQC 불합격은 본문 `defects` 가
 * 1줄 이상이어야 한다(`:confirm` 의 `assertRejectionRecorded` 와 같은 규칙 · 2026-10-16 결정).
 * ⛔ 거부는 채번 «앞»이다 — 400 이 될 저장에 번호를 태우지 않는다.
 */
export async function prepareRejectionDefects(
  prisma: PrismaService,
  defects: DefectRecordWriteService,
  body: Pick<InspectionResultCreate, 'inspectionRequestId' | 'overallJudgmentCode' | 'uomId' | 'defects' | 'rejectedQty'>,
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
  // 불합격 판정도 불합격 수량도 없는 회차에는 불량 기록을 두지 않는다 — `:confirm`(#121 · P-47)·작성중 저장(#122 · P-48)과 같은 규칙(#205).
  if (rows.length > 0 && !keepsDefects(body.overallJudgmentCode, body.rejectedQty)) {
    throw one(field('defects', ERROR_CODE.INVALID, NO_REJECTION));
  }
  if (rows.length === 0) {
    if (isIqc) throw one(field('defects', ERROR_CODE.REQUIRED, '불합격이면 불량 코드와 사유를 함께 보내야 합니다.'));
    return null;
  }
  // 합계는 확정으로 태어날 때만 맞춘다 — 작성중은 아직 입력하는 중이다.
  if (bornConfirmed) assertDefectSum(rows, Number(body.rejectedQty ?? 0));
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
    select: {
      uom_id: true,
      overall_judgment_code: true,
      rejected_qty: true,
      inspection_request: { select: { inspection_type_code: true } },
    },
  });
  // 없는 결과는 트랜잭션의 잠금이 404 로 답한다.
  if (result === null) return null;
  const isIqc = result.inspection_request.inspection_type_code === IQC;
  const judgment = body.overallJudgmentCode ?? result.overall_judgment_code;
  const rejectedQty = Number(result.rejected_qty);
  if (body.defects.length === 0) {
    if (isIqc && judgment === REJECTED) throw one(field('defects', ERROR_CODE.REQUIRED, '불합격이면 불량 코드와 사유를 함께 보내야 합니다.'));
    return null;
  }
  if (!isIqc) throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 IQC 검사 결과에만 함께 보낼 수 있습니다.'));
  if (!keepsDefects(judgment, rejectedQty)) throw one(field('defects', ERROR_CODE.INVALID, NO_REJECTION));
  // ⛔ 합계 거부도 트랜잭션·부적합 채번 «앞»이다 — 안에서 다시 보는 것은 잠근 뒤의 수량 대조다.
  assertDefectSum(body.defects, rejectedQty);
  return defects.prepareInspectionDefects(body.defects, Number(result.uom_id));
}

/**
 * 확정 직전, 그 회차의 IQC 불량 기록을 확정 판정·불합격 수량에 맞춘다(omf-all-around#121 · 장부 P-47 · #205).
 * - 불합격 판정이거나 불합격 수량이 있고 본문 사유: 기존 기록을 지우고 본문 값으로 다시 쓴다 — 한 회차의 사유는 확정 시점 입력 1벌이다.
 * - 같은 경우 사유 없음: 임시 저장한 기록을 그대로 쓴다(불합격 판정이면 `assertRejectionRecorded` 가 기록을 요구한다).
 * - 불합격 수량 0 인 합격·보류: 확정 전에 붙었던 기록을 지운다.
 * - 남는 기록의 수량 합계는 불합격 수량과 같아야 한다(불합격 수량이 있을 때).
 * ⛔ 확정과 같은 트랜잭션이다 — 확정이 실패하면 기록 변경도 함께 되돌려진다.
 */
export async function syncConfirmDefectsWithin(
  tx: Prisma.TransactionClient,
  defects: DefectRecordWriteService,
  input: {
    inspectionResultId: bigint;
    inspectionRequestId: bigint;
    judgment: string | undefined;
    /** 잠근 뒤 읽은 회차의 불합격 수량. */
    rejectedQty: number;
    prepared: PreparedInspectionDefects | null;
    detectedAt: Date;
    actor: { appUserId: number; workerId: bigint };
  },
): Promise<void> {
  const keeps = keepsDefects(input.judgment, input.rejectedQty);
  const request = await tx.inspection_request.findUnique({
    where: { inspection_request_id: input.inspectionRequestId },
    select: { inspection_type_code: true, lot_id: true, work_order_id: true },
  });
  if (request?.inspection_type_code !== IQC) return;
  // 밖에서 읽은 판정·수량과 잠근 뒤의 값이 갈린 경우 — 불량을 둘 수 없는 확정에 사유를 남기지 않는다.
  if (input.prepared !== null && !keeps) throw one(field('defects', ERROR_CODE.INVALID, NO_REJECTION));
  if (input.prepared === null && keeps) {
    const stored = await tx.defect_record.findMany({
      where: { inspection_result_id: input.inspectionResultId, source_type_code: IQC },
      select: { defect_qty: true },
    });
    assertDefectSum(stored.map((row) => ({ defectQty: Number(row.defect_qty) })), input.rejectedQty);
    return;
  }
  if (input.prepared !== null) assertDefectSum(input.prepared.rows, input.rejectedQty);
  await replaceIqcDefectsWithin(tx, defects, request, input);
}

/**
 * 작성중 저장(`PUT …/inspection-results/{id}`)의 불합격 사유(omf-all-around#122 · 장부 P-48) — 트랜잭션 «밖» 검증.
 * `undefined` = 싣지 않음(기록에 손대지 않는다) · `{ prepared: null }` = 빈 배열(그 회차의 IQC 기록을 지운다).
 */
export async function prepareDraftDefects(
  prisma: PrismaService,
  defects: DefectRecordWriteService,
  inspectionResultId: number,
  body: { overallJudgmentCode?: string; rejectedQty?: number; defects?: InspectionDefectInput[] },
): Promise<{ prepared: PreparedInspectionDefects | null } | undefined> {
  if (body.defects === undefined) return undefined;
  if (body.defects.length === 0) return { prepared: null };
  const result = await prisma.inspection_result.findUnique({
    where: { inspection_result_id: BigInt(inspectionResultId) },
    select: {
      uom_id: true,
      overall_judgment_code: true,
      rejected_qty: true,
      inspection_request: { select: { inspection_type_code: true } },
    },
  });
  // 없는 결과는 트랜잭션이 404 로 답한다.
  if (result === null) return undefined;
  if (result.inspection_request.inspection_type_code !== IQC) {
    throw one(field('defects', ERROR_CODE.INVALID, '불합격 사유는 IQC 검사 결과에만 함께 보낼 수 있습니다.'));
  }
  // 합계는 맞추지 않는다 — 작성중은 아직 입력하는 중이다(확정이 맞춘다 · #205).
  if (!keepsDefects(body.overallJudgmentCode ?? result.overall_judgment_code, body.rejectedQty ?? Number(result.rejected_qty))) {
    throw one(field('defects', ERROR_CODE.INVALID, NO_REJECTION));
  }
  return { prepared: await defects.prepareInspectionDefects(body.defects, Number(result.uom_id)) };
}

/** 작성중 회차의 IQC 불량 기록을 저장 본문으로 갈아 끼운다 — 저장과 같은 트랜잭션. IQC 가 아니면 손대지 않는다. */
export async function replaceDraftDefectsWithin(
  tx: Prisma.TransactionClient,
  defects: DefectRecordWriteService,
  input: {
    inspectionResultId: bigint;
    prepared: PreparedInspectionDefects | null;
    detectedAt: Date;
    actor: { appUserId?: number; workerId?: bigint | null };
  },
): Promise<void> {
  const result = await tx.inspection_result.findUniqueOrThrow({
    where: { inspection_result_id: input.inspectionResultId },
    select: { inspection_request: { select: { inspection_type_code: true, lot_id: true, work_order_id: true } } },
  });
  if (result.inspection_request.inspection_type_code !== IQC) return;
  await replaceIqcDefectsWithin(tx, defects, result.inspection_request, input);
}

async function replaceIqcDefectsWithin(
  tx: Prisma.TransactionClient,
  defects: DefectRecordWriteService,
  request: { lot_id: bigint | null; work_order_id: bigint | null },
  input: {
    inspectionResultId: bigint;
    prepared: PreparedInspectionDefects | null;
    detectedAt: Date;
    actor: { appUserId?: number; workerId?: bigint | null };
  },
): Promise<void> {
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
