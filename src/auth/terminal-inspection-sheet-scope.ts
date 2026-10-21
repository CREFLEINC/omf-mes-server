import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { oaOnly, oaPlantIds } from '../core/inspection-sheet';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';

/** POP 제품 검사표 입력(P-02-15 · omf-all-around#89 · 장부 P-102). */
export const TERMINAL_INSPECTION_SHEET_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /quality/inspection-sheets:open-by-serial': ['POP'],
  'GET /quality/inspection-sheets/{inspectionSheetId}': ['POP'],
  'PUT /quality/inspection-sheets/{inspectionSheetId}/header': ['POP'],
  'PUT /quality/inspection-sheets/{inspectionSheetId}/steps/{stepCode}': ['POP'],
  'PUT /quality/inspection-sheets/{inspectionSheetId}/ngs': ['POP'],
};

const WORKER = Symbol('terminalInspectionSheetWorkerId');

export function currentTerminalInspectionSheetWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [WORKER]?: bigint })[WORKER];
}

/**
 * 단말 공장이 OA 공장이어야 하고(아니면 403), 사번 헤더가 단말 공장의 재직 작업자여야 한다 — 그 작업자가 작성자·검사자다.
 * 검사표(또는 열 시리얼)의 LOT 이 단말 공장의 것이어야 한다. 조회도 사번을 요구한다 — 화면이 사번 인증 뒤에 연다.
 */
export async function assertTerminalInspectionSheetScope(
  prisma: PrismaService,
  request: Request,
  key: string,
  terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_INSPECTION_SHEET_OPERATIONS[key] || terminal.terminalTypeCode !== 'POP') throw denied();
  const workerNo = request.headers['x-worker-no'];
  if (typeof workerNo !== 'string' || !workerNo.trim()) throw denied();
  if (!key.startsWith('GET ')) {
    const correlationId = request.headers['idempotency-key'];
    if (typeof correlationId !== 'string' || !correlationId.trim()) throw denied();
  }
  const worker = await prisma.worker.findFirst({
    where: { worker_no: workerNo, plant_id: terminal.plantId, is_active: true },
    select: { worker_id: true },
  });
  if (!worker) throw denied();
  // OA 공장 단말만 — 부품 공장 단말은 403(담당자 결정 2026-10-21 · 공장 코드는 공통코드 INSPECTION_SHEET_PLANT).
  if (!(await oaPlantIds(prisma)).includes(terminal.plantId)) throw oaOnly();

  const owned =
    key === 'POST /quality/inspection-sheets:open-by-serial'
      ? await ownSerial(prisma, (request.body as Record<string, unknown> | undefined)?.serialNo, terminal.plantId)
      : await ownSheet(prisma, request.params.inspectionSheetId, terminal.plantId);
  if (!owned) throw denied();
  Object.defineProperty(request, WORKER, { value: worker.worker_id, configurable: true });
}

/** 없는 시리얼은 범위 밖이 아니라 서비스의 400 이다 — 다른 공장의 시리얼만 막는다. */
async function ownSerial(prisma: PrismaService, serialNo: unknown, plantId: bigint): Promise<boolean> {
  if (typeof serialNo !== 'string') return false;
  const serial = await prisma.serial_number.findUnique({
    where: { serial_no: serialNo },
    select: { lot: { select: { plant_id: true } } },
  });
  return serial === null || serial.lot.plant_id === plantId;
}

async function ownSheet(prisma: PrismaService, raw: unknown, plantId: bigint): Promise<boolean> {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return false;
  const id = BigInt(raw);
  if (id <= 0n || id >= 9223372036854775808n) return false;
  const count = await prisma.inspection_sheet.count({ where: { inspection_sheet_id: id, lot: { plant_id: plantId } } });
  return count === 1;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
