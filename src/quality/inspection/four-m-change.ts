import type { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 4M 변경품(omf-all-around#63 · 장부 P-86) — IQC 판정 때 자재 LOT 하나에 «변경품»과 변경 종류·비고를 적는다.
 * 변경 종류는 선택, 비고는 필수다(omf-all-around#133 · 장부 P-105 — IQC 화면은 비고만 받는다).
 * ⚠ 내부 「4M 자원배정」(W/O 자원 배정)과 다른 말이다.
 *
 * 검사 결과 쓰기 세 경로(`POST`·`PUT`·`:confirm`)가 같은 칸을 받는다 — 생략하면 손대지 않고, `null` 이면
 * 변경품이 아니다(줄 삭제), 값이면 그 LOT 의 한 줄을 갈아 끼운다. 결과 행과 같은 트랜잭션에서 쓴다.
 */
export interface FourMChangeInput {
  changeTypeCode?: string;
  remarks: string;
}

export interface PreparedFourMChange {
  lotId: bigint;
  inspectionRequestId: bigint;
  value: FourMChangeInput | null;
}

const CHANGE_TYPE_GROUP = 'FOUR_M_CHANGE_TYPE';

/** 트랜잭션 «밖»에서 대상과 코드를 대조한다 — 코드 표를 읽는 커넥션을 업무 트랜잭션이 쥐지 않는다. */
export async function prepareFourMChange(
  prisma: PrismaService,
  inspectionRequestId: bigint,
  input: FourMChangeInput | null | undefined,
): Promise<PreparedFourMChange | undefined> {
  if (input === undefined) return undefined;
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: { inspection_type_code: true, lot_id: true },
  });
  // 없는 의뢰는 결과 쓰기 자체가 404 로 막는다 — 여기서 먼저 다른 봉투를 내지 않는다.
  if (request === null) return undefined;
  if (request.inspection_type_code !== 'IQC' || request.lot_id === null) {
    throw one(field('fourMChange', ERROR_CODE.INVALID, '4M 변경품은 자재 LOT 이 있는 IQC 검사에만 적을 수 있습니다.'));
  }
  if (input !== null) {
    if (input.remarks.trim() === '') {
      throw one(field('fourMChange.remarks', ERROR_CODE.REQUIRED, '4M 변경품의 비고를 입력해 주세요.'));
    }
    if (input.changeTypeCode !== undefined) {
      await assertCodeValues(prisma, [
        { field: 'fourMChange.changeTypeCode', value: input.changeTypeCode, groupCode: CHANGE_TYPE_GROUP },
      ]);
    }
  }
  return { lotId: request.lot_id, inspectionRequestId, value: input };
}

/** 결과 id 만 아는 경로(`PUT`·`:confirm`)가 의뢰를 찾는다. 없는 결과는 각 경로가 404 로 막는다. */
export async function prepareFourMChangeOfResult(
  prisma: PrismaService,
  inspectionResultId: bigint,
  input: FourMChangeInput | null | undefined,
): Promise<PreparedFourMChange | undefined> {
  if (input === undefined) return undefined;
  const result = await prisma.inspection_result.findUnique({
    where: { inspection_result_id: inspectionResultId },
    select: { inspection_request_id: true },
  });
  return result === null ? undefined : prepareFourMChange(prisma, result.inspection_request_id, input);
}

export async function writeFourMChangeWithin(
  tx: Prisma.TransactionClient,
  prepared: PreparedFourMChange | undefined,
  appUserId: number | undefined,
): Promise<void> {
  if (prepared === undefined) return;
  if (prepared.value === null) {
    await tx.lot_four_m_change.deleteMany({ where: { lot_id: prepared.lotId } });
    return;
  }
  const remarks = prepared.value.remarks.trim();
  const changeTypeCode = prepared.value.changeTypeCode ?? null;
  await tx.lot_four_m_change.upsert({
    where: { lot_id: prepared.lotId },
    create: {
      lot_id: prepared.lotId,
      inspection_request_id: prepared.inspectionRequestId,
      change_type_code: changeTypeCode,
      remarks,
      created_by: appUserId ?? null,
    },
    update: {
      inspection_request_id: prepared.inspectionRequestId,
      change_type_code: changeTypeCode,
      remarks,
      updated_at: new Date(),
      updated_by: appUserId ?? null,
      version_no: { increment: 1 },
    },
  });
}

export interface FourMChangeRow {
  change_type_code: string | null;
  remarks: string | null;
}

/** 조회 응답의 모양 — 변경품이 아니면 칸이 없다. 변경 종류·비고가 비면 그 키가 없다(#133). */
export function fourMChangeView(row: FourMChangeRow | null | undefined) {
  if (row === null || row === undefined) return undefined;
  return {
    ...(row.change_type_code === null ? {} : { changeTypeCode: row.change_type_code }),
    ...(row.remarks === null ? {} : { remarks: row.remarks }),
  };
}
