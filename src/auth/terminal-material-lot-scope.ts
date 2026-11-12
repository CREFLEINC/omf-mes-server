import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import type { TerminalWorkerAuditActor } from '../audit/terminal-worker-audit';
import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { currentSession } from './session-resolver.service';
import { currentTerminal, type TerminalContext } from './terminal-context';

/**
 * 자재 관리 LOT 발행(POP P-01-01 · 피처 005 §1). 공장 범위 — 질의·본문의 `plantId` 는 단말 공장이어야 하고,
 * 폐기할 LOT 은 모두 단말 공장의 것이어야 한다. 쓰기는 활성 작업자(`X-Worker-No`)와 멱등 키가 필요하다.
 * 발행 화면이 공급사·품목 기본 정보(W-06-25 마스터)와 품목 단위 환산(보관 단위의 패키징당 수량)을 읽어 수량·포장을 채우므로 둘도 읽기로 연다.
 * 품목 단위 환산은 공장 축이 없는 마스터라 품목 조회(`terminal-read-policy.ts`)처럼 범위를 묻지 않는다.
 */
export const TERMINAL_MATERIAL_LOT_OPERATIONS: Readonly<Record<string, readonly 'POP'[]>> = {
  'GET /logistics/material-lot-batches': ['POP'],
  'GET /logistics/waiting-material-lots': ['POP'],
  'GET /mdm/supplier-item-defaults': ['POP'],
  'GET /mdm/items/{itemId}/uom-conversions': ['POP'],
  'POST /logistics/material-lot-batches': ['POP'],
  'POST /trace/lots:void': ['POP'],
};

const WORKER = Symbol('terminalMaterialLotWorkerId');
export function currentTerminalMaterialLotWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [WORKER]?: bigint })[WORKER];
}

export type MaterialLotWriteActor =
  | { appUserId: number; workerId?: never; terminalAudit?: never }
  | { appUserId?: never; workerId: bigint; terminalAudit: TerminalWorkerAuditActor };

/** 단말이면 범위 검사가 심은 작업자, 아니면 세션 계정 — 채널(POP·WEB)이 여기서 갈린다. */
export function materialLotWriteActorOf(request: Request, operationKey: string): MaterialLotWriteActor {
  const terminal = currentTerminal(request);
  if (terminal !== undefined) {
    const workerId = currentTerminalMaterialLotWorkerId(request);
    const workerNo = request.header('X-Worker-No');
    const correlationId = request.header('Idempotency-Key');
    if (workerId === undefined || !workerNo || !correlationId) {
      throw new UnauthorizedException('단말 작업자와 멱등 키가 필요합니다.');
    }
    return { workerId, terminalAudit: { workerId, workerNo, terminalId: terminal.terminalId,
      plantId: terminal.plantId, correlationId, operationKey } };
  }
  const session = currentSession(request);
  if (!session) throw new UnauthorizedException('세션이 필요합니다.');
  return { appUserId: session.userId };
}

export async function assertTerminalMaterialLotScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_MATERIAL_LOT_OPERATIONS[key]?.includes(terminal.terminalTypeCode as 'POP')) throw denied();
  const query = request.query as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (key.startsWith('GET ')) {
    if (query.plantId !== undefined && id(query.plantId) !== terminal.plantId) throw denied();
    return;
  }
  const workerNo = request.headers['x-worker-no'];
  const correlationId = request.headers['idempotency-key'];
  if (typeof workerNo !== 'string' || !workerNo.trim()
    || typeof correlationId !== 'string' || !correlationId.trim()) throw denied();
  const worker = await prisma.worker.findFirst({
    where: { worker_no: workerNo, plant_id: terminal.plantId, is_active: true }, select: { worker_id: true },
  });
  if (!worker) throw denied();
  if (key === 'POST /logistics/material-lot-batches') {
    if (id(body.plantId) !== terminal.plantId) throw denied();
  } else {
    const lotIds = Array.isArray(body.lotIds) ? body.lotIds.map(id) : [];
    if (lotIds.length === 0 || lotIds.includes(-1n)) throw denied();
    const inPlant = await prisma.lot.count({ where: { lot_id: { in: lotIds }, plant_id: terminal.plantId } });
    if (inPlant !== new Set(lotIds).size) throw denied();
  }
  Object.defineProperty(request, WORKER, { value: worker.worker_id, configurable: true });
}

function id(value: unknown): bigint {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) return -1n;
  const parsed = BigInt(value);
  return parsed > 0n && parsed < 9223372036854775808n ? parsed : -1n;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
