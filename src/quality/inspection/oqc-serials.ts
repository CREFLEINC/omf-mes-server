import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertOqcPicked, oqcPickedLots } from '../../logistics/shipment-request/shipment-oqc-lots';
import { PrismaService } from '../../prisma/prisma.service';
import type { InspectionResultCreate } from './inspection-result-write-input';
import { CONFIRMED } from './inspection-rules';

/**
 * 시리얼 OQC(omf-all-around#68 · 장부 P-101) — 출하작업지시 OQC 확정 저장에 «검사한 시리얼과 OK/NG» 를 싣는다.
 * 시리얼 판정은 `quality.oqc_serial_result` 에 시리얼당 한 줄로 남는다.
 * ⚠ 재검 회차가 같은 줄을 고친다 — 1차는 그대로, 최종과 마지막 회차만 바뀐다(Q4). 회차별 이력은 남지 않는다.
 */

const OQC = 'OQC';
const SHIPMENT_REQUEST_TARGET = 'SHIPMENT_REQUEST';

export type SerialJudgment = 'OK' | 'NG';

export interface OqcSerialJudgmentInput {
  serialNumberId: number;
  judgmentCode: string;
}

export interface PreparedOqcSerial {
  serialNumberId: bigint;
  serialNo: string;
  judgment: SerialJudgment;
}

/** 트랜잭션 «밖»의 검증. 시리얼이 없으면 `null` — 지금 저장 그대로다. 하나라도 어긋나면 결과째 400 이다(일부만 서지 않게). */
export async function prepareOqcSerials(
  prisma: PrismaService,
  body: InspectionResultCreate,
): Promise<PreparedOqcSerial[] | null> {
  const serials = body.serials ?? [];
  if (serials.length === 0) return null;
  if (body.statusCode !== CONFIRMED) throw invalid('시리얼 판정은 확정 저장에서만 받습니다.');
  if (new Set(serials.map((s) => s.serialNumberId)).size !== serials.length) throw invalid('같은 시리얼이 두 번 실렸습니다.');
  // Q3 — 수량 칸은 사람이 넣고, 시리얼과 모순되는 것만 막는다.
  if (serials.length > body.inspectedQty) throw invalid('검사한 시리얼 수가 검사 수량보다 많습니다.');
  if (serials.filter((s) => s.judgmentCode === 'NG').length > body.rejectedQty) {
    throw invalid('NG 시리얼 수가 불합격 수량보다 많습니다.');
  }

  const request = await prisma.inspection_request.findUniqueOrThrow({
    where: { inspection_request_id: body.inspectionRequestId },
    select: { inspection_type_code: true, target_type_code: true, target_id: true, item_id: true },
  });
  if (request.inspection_type_code !== OQC || request.target_type_code !== SHIPMENT_REQUEST_TARGET) {
    throw invalid('시리얼 판정은 출하작업지시 OQC 에서만 받습니다.');
  }
  const rows = await prisma.serial_number.findMany({
    where: { serial_number_id: { in: serials.map((s) => BigInt(s.serialNumberId)) } },
    select: { serial_number_id: true, serial_no: true, item_id: true, lot_id: true },
  });
  const byId = new Map(rows.map((row) => [String(row.serial_number_id), row]));
  const picked = await oqcPickedLots(prisma, request.target_id, request.item_id);
  assertOqcPicked(picked, '판정하세요');
  const pickedLots = new Set(picked.lotIds.map(String));
  return serials.map((serial) => {
    const row = byId.get(String(serial.serialNumberId));
    if (row === undefined) throw invalid('없는 시리얼입니다.');
    if (row.item_id !== request.item_id) throw invalid(`시리얼 ${row.serial_no} 은 이 의뢰의 품목이 아닙니다.`);
    if (!pickedLots.has(String(row.lot_id))) throw invalid(`시리얼 ${row.serial_no} 의 LOT 은 이 출하작업지시가 피킹한 LOT 이 아닙니다.`);
    return { serialNumberId: row.serial_number_id, serialNo: row.serial_no, judgment: serial.judgmentCode as SerialJudgment };
  });
}

/**
 * 결과와 같은 트랜잭션에서 시리얼마다 한 줄을 쓴다. 이미 줄이 있으면 1차는 그대로 두고 최종·회차·검사자·시각만 바꾼다(Q4).
 * ⛔ 1차가 OK 인 시리얼을 NG 로는 못 바꾼다 — NG → 수리 → 재검 OK 만 있다(DB `ck_oqc_serial_result_first_ok` 와 같은 규칙).
 */
export async function recordOqcSerialsWithin(
  tx: Prisma.TransactionClient,
  serials: readonly PreparedOqcSerial[],
  at: { inspectionResultId: bigint; inspectedAt: Date; workerId: bigint | null; appUserId: bigint | null },
): Promise<void> {
  for (const serial of serials) {
    const previous = await tx.oqc_serial_result.findUnique({
      where: { serial_number_id: serial.serialNumberId },
      select: { first_judgment_code: true },
    });
    if (previous?.first_judgment_code === 'OK' && serial.judgment === 'NG') {
      throw invalid(`시리얼 ${serial.serialNo} 은 1차 판정이 OK 라 NG 로 바꿀 수 없습니다.`);
    }
    const values = {
      final_judgment_code: serial.judgment,
      inspection_result_id: at.inspectionResultId,
      inspected_worker_id: at.workerId,
      inspected_at: at.inspectedAt,
      updated_by: at.appUserId,
    };
    await tx.oqc_serial_result.upsert({
      where: { serial_number_id: serial.serialNumberId },
      create: {
        serial_number_id: serial.serialNumberId,
        first_judgment_code: serial.judgment,
        created_by: at.appUserId,
        ...values,
      },
      update: { ...values, updated_at: new Date(), version_no: { increment: 1 } },
    });
  }
}

function invalid(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field: 'serials', code: ERROR_CODE.INVALID, message }]);
}
