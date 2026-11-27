import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import type { TerminalWorkerAuditActor } from '../audit/terminal-worker-audit';
import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { currentSession } from './session-resolver.service';
import { currentTerminal, type TerminalContext } from './terminal-context';

type TerminalType = 'POP' | 'MOBILE';

/**
 * 반납 입고(피처 019 · POP P-01-03 · PDA M-01-15). 공장 범위 — LOT·W/O·위치는 서비스가 단말 공장으로 좁힌다.
 * POP 은 단말 공정 매핑 「반납 가능」(`can_return_material`)이 하나라도 켜진 단말만 연다(FR-006 · D-4) — 화면 목록
 * (`terminal-accessible-screens.ts` 의 P-01-03)과 같은 축이다. 꺼진 POP 은 403(조치를 알린다). PDA 는 단말 종류만 본다.
 * 쓰기는 활성 작업자(`X-Worker-No`)와 멱등 키가 필요하다.
 */
export const TERMINAL_MATERIAL_RETURN_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  'GET /production/material-returns/lot-lookup': ['POP', 'MOBILE'],
  'GET /production/material-returns/work-orders': ['POP', 'MOBILE'],
  'GET /production/material-returns/work-orders/{workOrderId}/lots': ['POP', 'MOBILE'],
  'POST /production/material-returns': ['POP', 'MOBILE'],
};

const WORKER = Symbol('terminalMaterialReturnWorkerId');

export type MaterialReturnActor =
  | { appUserId: number; workerId?: never; terminalAudit?: never; terminalKindCode?: never }
  | { appUserId?: never; workerId: bigint; terminalAudit: TerminalWorkerAuditActor; terminalKindCode: 'POP' | 'PDA' };

/** 단말이면 범위 검사가 심은 작업자, 아니면 세션 계정. */
export function materialReturnActorOf(request: Request, operationKey: string): MaterialReturnActor {
  const terminal = currentTerminal(request);
  if (terminal !== undefined) {
    const workerId = (request as Request & { [WORKER]?: bigint })[WORKER];
    const workerNo = request.header('X-Worker-No');
    const correlationId = request.header('Idempotency-Key');
    if (workerId === undefined || !workerNo || !correlationId) throw new UnauthorizedException('단말 작업자와 멱등 키가 필요합니다.');
    return {
      workerId, terminalKindCode: terminal.terminalTypeCode === 'POP' ? 'POP' : 'PDA',
      terminalAudit: { workerId, workerNo, terminalId: terminal.terminalId, plantId: terminal.plantId, correlationId, operationKey },
    };
  }
  const session = currentSession(request);
  if (!session) throw new UnauthorizedException('세션이 필요합니다.');
  return { appUserId: session.userId };
}

export async function assertTerminalMaterialReturnScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_MATERIAL_RETURN_OPERATIONS[key]?.includes(terminal.terminalTypeCode as TerminalType)) throw denied();
  if (terminal.terminalTypeCode === 'POP') {
    const open = await prisma.terminal_process.findFirst({
      where: { terminal_id: terminal.terminalId, can_return_material: true }, select: { terminal_process_id: true },
    });
    if (open === null) throw flagDenied();
  }
  if (key.startsWith('GET ')) return;
  const workerNo = request.headers['x-worker-no'];
  const correlationId = request.headers['idempotency-key'];
  if (typeof workerNo !== 'string' || !workerNo.trim() || typeof correlationId !== 'string' || !correlationId.trim()) throw denied();
  const worker = await prisma.worker.findFirst({
    where: { worker_no: workerNo, plant_id: terminal.plantId, is_active: true }, select: { worker_id: true },
  });
  if (!worker) throw denied();
  Object.defineProperty(request, WORKER, { value: worker.worker_id, configurable: true });
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}

/** 권한만 빠진 경우 — 관리자가 무엇을 켜야 하는지 알린다(`terminal-production-scope.ts` 의 flagDenied 와 같은 문장 틀). */
function flagDenied(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [{
    scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED,
    message: '이 단말에는 반납 입고 권한이 없습니다. 관리웹 시스템 관리 › 단말기-공정 매핑에서 이 단말 공정의 「반납 가능」을 켜세요.',
  }]);
}
