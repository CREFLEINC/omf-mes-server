import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import { terminalQualityWorkOrderWhere } from './terminal-quality-read-scope';

export const TERMINAL_QUALITY_WRITE_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /quality/inspection-results': ['POP'],
  // ⭐ P-02-14 자재 불량 등록(장부 P-52) — 기록과, 고르면 그 LOT 의 보류.
  'POST /quality/defect-records': ['POP'],
  'POST /quality/lot-holds': ['POP'],
};

/** POP 이 남길 수 있는 불량 기록 원천 — 자재 불량 하나다. 검사 불량은 검사 화면의 몫이다. */
const POP_DEFECT_SOURCE = 'MATERIAL';

const ATTACHED = Symbol('terminalQualityWorkerId');

export function currentTerminalQualityWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [ATTACHED]?: bigint })[ATTACHED];
}

/**
 * POP 쓰기 범위. 셋 다 **사번 헤더가 단말 공장의 재직 작업자**여야 하고 그 작업자가 기록 주체다.
 * - 검사 결과: 이 단말 공정의 W/O 의뢰
 * - 불량 기록(P-02-14): 자재 불량 원천 · 단말 공장의 LOT
 * - LOT 보류(P-02-14): 보류할 LOT 이 전부 단말 공장의 것
 */
export async function assertTerminalQualityWriteScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_QUALITY_WRITE_OPERATIONS[key] || terminal.terminalTypeCode !== 'POP') throw denied();
  const workerNo = request.headers['x-worker-no'];
  const correlationId = request.headers['idempotency-key'];
  if (typeof workerNo !== 'string' || !workerNo.trim() || typeof correlationId !== 'string' || !correlationId.trim()) {
    throw denied();
  }
  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const [worker] = await Promise.all([
    prisma.worker.findFirst({ where: {
      worker_no: workerNo, plant_id: terminal.plantId, is_active: true,
    }, select: { worker_id: true } }),
    assertOwnTarget(prisma, key, body, terminal),
  ]);
  if (!worker) throw denied();
  Object.defineProperty(request, ATTACHED, { value: worker.worker_id, configurable: true });
}

async function assertOwnTarget(
  prisma: PrismaService, key: string, body: Record<string, unknown>, terminal: TerminalContext,
): Promise<void> {
  if (key === 'POST /quality/inspection-results') {
    const requestId = positiveId(body.inspectionRequestId);
    if (requestId === null || !await prisma.inspection_request.findFirst({ where: {
      inspection_request_id: requestId,
      work_order: terminalQualityWorkOrderWhere({
        plantId: terminal.plantId, terminalId: terminal.terminalId, terminalTypeCode: 'POP',
      }),
    }, select: { inspection_request_id: true } })) throw denied();
    return;
  }
  const lotIds = key === 'POST /quality/defect-records'
    ? (body.sourceCode === POP_DEFECT_SOURCE ? [positiveId(body.lotId)] : [null])
    : (Array.isArray(body.lots) ? body.lots : [null]).map((ref) =>
      positiveId((ref as Record<string, unknown> | null)?.lotId));
  if (lotIds.length === 0 || lotIds.some((id) => id === null)) throw denied();
  const ids = [...new Set(lotIds as bigint[])];
  const owned = await prisma.lot.count({ where: { lot_id: { in: ids }, plant_id: terminal.plantId } });
  if (owned !== ids.length) throw denied();
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const id = BigInt(value);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
