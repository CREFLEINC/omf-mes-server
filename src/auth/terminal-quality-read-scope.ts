import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';

type TerminalType = 'POP' | 'MOBILE';

/** Exact quality/repair GETs in the POP and MOBILE client API inventory. */
export const TERMINAL_QUALITY_READ_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  'GET /quality/inspection-requests': ['POP'],
  'GET /quality/inspection-requests/{inspectionRequestId}': ['POP'],
  'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}': ['POP'],
  'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}/items': ['POP'],
  'GET /quality/inspection-plans/{inspectionPlanId}': ['POP'],
  'GET /quality/nonconformances/{nonconformanceId}': ['POP'],
  'GET /quality/nonconformances/{nonconformanceId}/disposition-decisions': ['POP'],
  'GET /quality/defect-codes': ['MOBILE'],
  'GET /quality/defect-records': ['MOBILE'],
  'GET /production/repair-executions': ['MOBILE'],
};

export interface TerminalQualityReadScope {
  readonly plantId: bigint;
  readonly terminalId: bigint;
  readonly terminalTypeCode: TerminalType;
}

const ATTACHED = Symbol('terminalQualityReadScope');

export function currentTerminalQualityReadScope(request: Request): TerminalQualityReadScope | undefined {
  return (request as Request & { [ATTACHED]?: TerminalQualityReadScope })[ATTACHED];
}

/** POP inspection/NCR rows belong to a W/O routed to a process allowed on this terminal. */
export function terminalQualityWorkOrderWhere(scope: TerminalQualityReadScope): Prisma.work_orderWhereInput {
  return {
    production_line: { plant_id: scope.plantId },
    routing_operation: { process: { terminal_process: {
      some: { terminal_id: scope.terminalId, can_start_work: true },
    } } },
  };
}

export async function assertTerminalQualityReadScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  const types = TERMINAL_QUALITY_READ_OPERATIONS[key];
  if (!types?.includes(terminal.terminalTypeCode as TerminalType)) throw denied();
  const scope: TerminalQualityReadScope = Object.freeze({
    plantId: terminal.plantId, terminalId: terminal.terminalId,
    terminalTypeCode: terminal.terminalTypeCode as TerminalType,
  });
  const query = request.query as Record<string, unknown>;
  const mappedWorkOrder = terminalQualityWorkOrderWhere(scope);
  const ownLot = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.lot.findFirst({
      where: { lot_id: id, plant_id: scope.plantId }, select: { lot_id: true },
    })) throw denied();
  };
  const ownWorkOrder = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.work_order.findFirst({
      where: { work_order_id: id, ...mappedWorkOrder }, select: { work_order_id: true },
    })) throw denied();
  };
  const ownInspectionRequest = async (where: Prisma.inspection_requestWhereInput): Promise<void> => {
    if (!await prisma.inspection_request.findFirst({
      where: { ...where, work_order: mappedWorkOrder }, select: { inspection_request_id: true },
    })) throw denied();
  };
  const ownNonconformance = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.nonconformance.findFirst({
      where: { nonconformance_id: id,
        work_order_nonconformance_work_order_idTowork_order: mappedWorkOrder },
      select: { nonconformance_id: true },
    })) throw denied();
  };

  switch (key) {
    case 'GET /quality/inspection-requests':
      await ownWorkOrder(query.workOrderId);
      break;
    case 'GET /quality/inspection-requests/{inspectionRequestId}': {
      const id = positiveId(request.params.inspectionRequestId);
      if (id === null) throw denied();
      await ownInspectionRequest({ inspection_request_id: id });
      break;
    }
    case 'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}':
    case 'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}/items': {
      const id = positiveId(request.params.inspectionPlanVersionId);
      if (id === null) throw denied();
      await ownInspectionRequest({ inspection_plan_version_id: id });
      break;
    }
    case 'GET /quality/inspection-plans/{inspectionPlanId}': {
      const id = positiveId(request.params.inspectionPlanId);
      if (id === null) throw denied();
      await ownInspectionRequest({ inspection_plan_version: { inspection_plan_id: id } });
      break;
    }
    case 'GET /quality/nonconformances/{nonconformanceId}':
    case 'GET /quality/nonconformances/{nonconformanceId}/disposition-decisions':
      await ownNonconformance(request.params.nonconformanceId);
      break;
    case 'GET /quality/defect-records':
      await ownLot(query.lotId);
      break;
    case 'GET /production/repair-executions':
      if (query.open !== 'true') throw denied();
      if (query.lotId !== undefined) await ownLot(query.lotId);
      break;
    case 'GET /quality/defect-codes':
      // Shared defect-code master has no plant relation in the schema.
      break;
    default:
      throw denied();
  }
  Object.defineProperty(request, ATTACHED, { value: scope, configurable: true });
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
