import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultRow } from './production-result-view';

/** 실적 본문의 불량 유형 한 줄. */
export interface ResultDefectInput {
  defectCodeId: number;
  qty: number;
}

/** 계약 `ProductionResultDefect`. 대분류 칸은 상세 코드일 때만 있다 — 다른 경로가 대분류로 남긴 기록도 실린다. */
export interface ResultDefectView {
  defectRecordId: number;
  defectCodeId: number;
  defectCode: string;
  defectName: string;
  nameKo?: string;
  nameVi?: string;
  parentDefectCodeId?: number;
  parentDefectCode?: string;
  parentDefectName?: string;
  qty: number;
}

/** 현장에서 발견한 불량 — 공통코드 `DEFECT_RECORD_SOURCE` 의 값이다. 집계의 잎 규칙(`defect-view.ts` `LATEST_RESULT_ONLY`)이 이 원천만 본다. */
const FIELD_SOURCE = 'FIELD';

/**
 * 유형별 수량을 검사하고 불량수량을 정한다. `defects` 만 오면 그 합이 불량수량이다.
 * ⭐ `defects` 없이 불량수량만 오는 실적은 그대로 받는다 — 기존 단말·오프라인 재전송이 깨지지 않게(장부 P-89).
 * 합은 소수 여섯째 자리(qty_t)로 견준다 — 0.1 + 0.2 같은 부동소수 끝전이 400 이 되지 않게.
 */
export function resolveDefectQty(body: { defectQty?: number; defects?: readonly ResultDefectInput[] }): number | undefined {
  const defects = body.defects ?? [];
  if (defects.length === 0) return body.defectQty;
  const seen = new Set<number>();
  let sum = 0;
  for (const [index, row] of defects.entries()) {
    if (!(row.qty > 0)) throw one(field(`defects[${index}].qty`, ERROR_CODE.RANGE, '불량 수량은 0보다 커야 합니다.'));
    // 칸이 소수 여섯째 자리까지다 — 넘는 값은 저장 때 반올림돼 0 이 되면 CHECK 위반(500)이고, 아니어도 합이 어긋난다.
    if (round6(row.qty) !== row.qty) {
      throw one(field(`defects[${index}].qty`, ERROR_CODE.RANGE, '불량 수량은 소수 여섯째 자리까지입니다.'));
    }
    // ⛔ `UNIQUE_VIOLATION` 이 아니다 — 요청 «안»의 중복은 저장 충돌이 아니라 입력 오류다.
    if (seen.has(row.defectCodeId)) {
      throw one(field(`defects[${index}].defectCodeId`, ERROR_CODE.INVALID, '같은 불량 코드를 두 번 실을 수 없습니다.'));
    }
    seen.add(row.defectCodeId);
    sum += row.qty;
  }
  const total = round6(sum);
  if (body.defectQty !== undefined && round6(body.defectQty) !== total) {
    throw one(field('defects', ERROR_CODE.INVALID, '불량 유형 수량의 합이 불량수량과 다릅니다.'));
  }
  return total;
}

/**
 * 불량 코드가 그 W/O 공정의 상세 코드인가 — 정본은 `defect_code_process` 매핑이다(`defect_code.process_id` 가 아니다).
 * `GET /quality/defect-codes?processId=` 가 같은 기준이라 그 목록에서 고른 코드는 여기를 통과한다.
 * ⛔ 트랜잭션 «밖»이다 — 읽기 커넥션을 업무 트랜잭션이 쥐지 않는다(채번과 같은 규율).
 * @returns 발생·검출 공정. 없는 W/O 면 `null` — 잠금(`lockWorkOrder`)이 404 로 답한다.
 */
export async function assertDefectCodes(
  prisma: PrismaService,
  workOrderId: number,
  defects: readonly ResultDefectInput[],
): Promise<bigint | null> {
  if (defects.length === 0) return null;
  const workOrder = await prisma.work_order.findUnique({
    where: { work_order_id: BigInt(workOrderId) },
    select: { routing_operation: { select: { process_id: true } } },
  });
  if (workOrder === null) return null;
  const processId = workOrder.routing_operation.process_id;
  const codes = await prisma.defect_code.findMany({
    where: { defect_code_id: { in: defects.map((row) => BigInt(row.defectCodeId)) } },
    select: {
      defect_code_id: true,
      is_active: true,
      parent_defect_code_id: true,
      defect_code_process: { where: { process_id: processId }, select: { defect_code_process_id: true } },
    },
  });
  const byId = new Map(codes.map((code) => [Number(code.defect_code_id), code]));
  const errors: ErrorItem[] = [];
  for (const [index, row] of defects.entries()) {
    const code = byId.get(row.defectCodeId);
    const name = `defects[${index}].defectCodeId`;
    if (code === undefined || !code.is_active || code.parent_defect_code_id === null) {
      errors.push(field(name, ERROR_CODE.INVALID, '사용할 수 없는 불량 코드입니다 — 사용 중인 상세 코드여야 합니다.'));
    } else if (code.defect_code_process.length === 0) {
      errors.push(field(name, ERROR_CODE.INVALID, '이 MES W/O 의 공정에 매핑되지 않은 불량 코드입니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return processId;
}

/**
 * 실적과 «같은 트랜잭션»에서 유형별 불량 기록을 남긴다 — 실적만 서고 기록이 빠지는 일이 없다.
 * ⛔ LOT 은 비운다 — 불량품은 그 실적의 양품 LOT 에 들어 있지 않아, 달면 추적(S32)이 거짓말을 한다(사용자 결정 2026-10-21).
 * 작업자·설비·금형·시각은 실적 행 값 그대로다.
 */
export async function writeDefects(
  tx: Prisma.TransactionClient,
  row: ProductionResultRow,
  defects: readonly ResultDefectInput[],
  processId: bigint | null,
  appUserId: number | undefined,
): Promise<void> {
  if (defects.length === 0 || processId === null) return;
  await tx.defect_record.createMany({
    data: defects.map((defect) => ({
      source_type_code: FIELD_SOURCE,
      production_result_id: row.production_result_id,
      work_order_id: row.work_order_id,
      defect_code_id: BigInt(defect.defectCodeId),
      defect_qty: new Prisma.Decimal(defect.qty),
      uom_id: row.uom_id,
      occurrence_process_id: processId,
      detection_process_id: processId,
      worker_id: row.worker_id,
      equipment_id: row.equipment_id,
      mold_id: row.mold_id,
      occurred_at: row.occurred_at,
      detected_at: row.occurred_at,
      created_by: appUserId ?? null,
    })),
  });
}

/**
 * 원본 실적의 유형별 내역(FIELD 기록)을 정정본에 옮겨 적는다 — 원본 기록은 이력으로 남고 집계는 정정본 것을 센다.
 * ⛔ 코드를 다시 검증하지 않는다 — 그 사이 코드가 비활성·매핑 해제됐어도 원본의 사실이다.
 */
export async function copyDefects(
  tx: Prisma.TransactionClient,
  row: ProductionResultRow,
  originalId: bigint,
  appUserId: number | undefined,
): Promise<void> {
  const original = await tx.defect_record.findMany({
    where: { production_result_id: originalId, source_type_code: FIELD_SOURCE },
    orderBy: { defect_record_id: 'asc' },
  });
  if (original.length === 0) return;
  await tx.defect_record.createMany({
    data: original.map((record) => ({
      source_type_code: FIELD_SOURCE,
      production_result_id: row.production_result_id,
      work_order_id: record.work_order_id,
      defect_code_id: record.defect_code_id,
      defect_qty: record.defect_qty,
      uom_id: record.uom_id,
      occurrence_process_id: record.occurrence_process_id,
      detection_process_id: record.detection_process_id,
      worker_id: record.worker_id,
      equipment_id: record.equipment_id,
      mold_id: record.mold_id,
      occurred_at: record.occurred_at,
      detected_at: record.detected_at,
      created_by: appUserId ?? null,
    })),
  });
}

/** 실적 여럿의 불량 기록을 한 번에 읽는다 — 목록이 행마다 돌지 않게. */
export async function loadDefects(
  prisma: Pick<Prisma.TransactionClient, 'defect_record'>,
  resultIds: readonly bigint[],
): Promise<Map<bigint, ResultDefectView[]>> {
  const map = new Map<bigint, ResultDefectView[]>();
  if (resultIds.length === 0) return map;
  const rows = await prisma.defect_record.findMany({
    where: { production_result_id: { in: [...resultIds] } },
    orderBy: { defect_record_id: 'asc' },
    include: {
      defect_code: {
        select: {
          defect_code: true,
          defect_name: true,
          name_ko: true,
          name_vi: true,
          parent_defect_code: { select: { defect_code_id: true, defect_code: true, defect_name: true } },
        },
      },
    },
  });
  for (const row of rows) {
    const resultId = row.production_result_id as bigint;
    const parent = row.defect_code.parent_defect_code;
    const view: ResultDefectView = {
      defectRecordId: Number(row.defect_record_id),
      defectCodeId: Number(row.defect_code_id),
      defectCode: row.defect_code.defect_code,
      defectName: row.defect_code.defect_name,
      ...(row.defect_code.name_ko === null ? {} : { nameKo: row.defect_code.name_ko }),
      ...(row.defect_code.name_vi === null ? {} : { nameVi: row.defect_code.name_vi }),
      ...(parent === null
        ? {}
        : {
            parentDefectCodeId: Number(parent.defect_code_id),
            parentDefectCode: parent.defect_code,
            parentDefectName: parent.defect_name,
          }),
      qty: row.defect_qty.toNumber(),
    };
    map.set(resultId, [...(map.get(resultId) ?? []), view]);
  }
  return map;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
