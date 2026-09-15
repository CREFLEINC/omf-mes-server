import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { CONTRACT_OPERATION } from '../common/contract';
import { ContractException } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticationGuard } from './authentication.guard';
import { currentSession } from './session-resolver.service';
import { SessionResolver } from './session-resolver.service';
import { currentTerminal } from './terminal-context';
import { currentTerminalInventoryScope } from './terminal-inventory-scope';
import { TERMINAL_ACCESSIBLE_SCREENS_OPERATION, TERMINAL_REGISTRATION_OPERATION } from './terminal-registration-operation';
import { TERMINAL_READ_OPERATIONS } from './terminal-read-policy';
import { TERMINAL_QUALITY_READ_OPERATIONS } from './terminal-quality-read-scope';

const jwt = new JwtService({ secret: 'fr004-terminal-auth-test-secret-long-enough' });

function setup(type: 'POP' | 'MOBILE' = 'MOBILE', options: { active?: boolean; version?: number; account?: boolean; plantId?: bigint } = {}) {
  const terminal = {
    terminal_id: 7n, terminal_code: 'FR004-DEVICE-01', plant_id: options.plantId ?? 3n,
    terminal_type_code: type, equipment_id: 5n,
    is_active: options.active ?? true, token_version: options.version ?? 2,
  };
  const prisma = {
    terminal: { findUnique: jest.fn().mockResolvedValue(terminal) },
    work_order: { findFirst: jest.fn().mockResolvedValue({ work_order_id: 11n }) },
    terminal_process: { findMany: jest.fn().mockResolvedValue([{ process_id: 13n }]) },
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 19n }) },
    equipment: { findFirst: jest.fn().mockResolvedValue({ equipment_id: 5n }) },
    warehouse: { findFirst: jest.fn().mockResolvedValue({ warehouse_id: 29n }) },
    mold: { findFirst: jest.fn().mockResolvedValue({ mold_id: 31n }) },
    location: { findFirst: jest.fn().mockResolvedValue({ location_id: 37n }) },
    lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
    handling_unit: { findFirst: jest.fn().mockResolvedValue({ handling_unit_id: 47n }) },
    inspection_request: { findFirst: jest.fn().mockResolvedValue({ inspection_request_id: 61n }) },
    nonconformance: { findFirst: jest.fn().mockResolvedValue({ nonconformance_id: 67n }) },
  } as unknown as PrismaService;
  const account = { userId: 1, permissions: ['W-CO-06'] };
  const resolver = { resolve: jest.fn().mockResolvedValue(options.account ? account : null) } as unknown as SessionResolver;
  const guard = new AuthenticationGuard(new Reflector(), resolver, jwt, prisma);
  const token = jwt.sign({ sub: 7, typ: 'terminal', tv: 2, terminalCode: terminal.terminal_code, plantId: 3 });
  return { guard, prisma, token };
}

function context(key: string, query: Record<string, unknown>, params: Record<string, string>, authorization?: string) {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  const request = { headers, query, params, body: {},
    header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
  const handler = (): void => undefined;
  Reflect.defineMetadata(CONTRACT_OPERATION, key, handler);
  const execution = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, execution };
}

function registrationContext(authorization?: string) {
  const result = context('POST /mdm/terminals/{terminalId}:confirm-registration', {}, { terminalId: '7' }, authorization);
  Reflect.defineMetadata(TERMINAL_REGISTRATION_OPERATION, true, result.execution.getHandler());
  return result;
}

function accessibleScreensContext(authorization?: string, terminalId = '7') {
  const result = context('GET /mdm/terminals/{terminalId}/accessible-screens', {}, { terminalId }, authorization);
  Reflect.defineMetadata(TERMINAL_ACCESSIBLE_SCREENS_OPERATION, true, result.execution.getHandler());
  return result;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContractException);
  return (error as ContractException).getStatus();
}

describe('FR-004/005 terminal bearer authentication', () => {
  it('accepts POP registration only with its current, active, same-plant bearer', async () => {
    const pop = setup('POP');
    const own = registrationContext(`Bearer ${pop.token}`);
    expect(await pop.guard.canActivate(own.execution)).toBe(true);
    expect(currentTerminal(own.request)).toMatchObject({ terminalId: 7n, plantId: 3n, terminalTypeCode: 'POP' });
    expect(await statusOf(pop.guard.canActivate(registrationContext().execution))).toBe(401);
    expect(await statusOf(setup('POP', { version: 3 }).guard.canActivate(
      registrationContext(`Bearer ${pop.token}`).execution))).toBe(401);
    expect(await statusOf(setup('POP', { active: false }).guard.canActivate(
      registrationContext(`Bearer ${pop.token}`).execution))).toBe(401);
    expect(await statusOf(setup('POP', { plantId: 4n }).guard.canActivate(
      registrationContext(`Bearer ${pop.token}`).execution))).toBe(401);
  });

  it('allows only the own current POP bearer to read accessible screens', async () => {
    const pop = setup('POP');
    const own = accessibleScreensContext(`Bearer ${pop.token}`);
    expect(await pop.guard.canActivate(own.execution)).toBe(true);
    expect(currentTerminal(own.request)).toMatchObject({ terminalId: 7n, plantId: 3n, terminalTypeCode: 'POP' });
    expect(await statusOf(pop.guard.canActivate(accessibleScreensContext().execution))).toBe(401);
    expect(await statusOf(pop.guard.canActivate(accessibleScreensContext(`Bearer ${pop.token}`, '8').execution))).toBe(401);
    expect(await statusOf(setup('MOBILE').guard.canActivate(
      accessibleScreensContext(`Bearer ${setup('MOBILE').token}`).execution))).toBe(401);
    expect(await statusOf(setup('POP', { version: 3 }).guard.canActivate(
      accessibleScreensContext(`Bearer ${pop.token}`).execution))).toBe(401);
    expect(await statusOf(setup('POP', { active: false }).guard.canActivate(
      accessibleScreensContext(`Bearer ${pop.token}`).execution))).toBe(401);
    expect(await statusOf(setup('POP', { plantId: 4n }).guard.canActivate(
      accessibleScreensContext(`Bearer ${pop.token}`).execution))).toBe(401);
  });

  it('keeps the 42 reviewed generic and quality read keys disjoint', () => {
    const generic = Object.keys(TERMINAL_READ_OPERATIONS);
    const quality = Object.keys(TERMINAL_QUALITY_READ_OPERATIONS);
    expect(generic).toHaveLength(32);
    expect(quality).toHaveLength(10);
    expect(new Set([...generic, ...quality]).size).toBe(42);
    expect([...generic, ...quality].every((key) => key.startsWith('GET '))).toBe(true);
  });

  it('accepts mobile worker-directory bearer without an account session and attaches its plant', async () => {
    const { guard, token } = setup();
    const { request, execution } = context('GET /mdm/workers', { plantId: '3', includeInactive: 'false' }, {}, `Bearer ${token}`);
    expect(await guard.canActivate(execution)).toBe(true);
    expect(currentTerminal(request)).toMatchObject({ terminalId: 7n, plantId: 3n, terminalTypeCode: 'MOBILE' });
    expect(currentSession(request)).toBeUndefined();
    expect(request.query.plantId).toBe(3);
  });

  it('accepts POP worker-number lookup and scopes its otherwise unfiltered plant', async () => {
    const { guard, token } = setup('POP');
    const { request, execution } = context('GET /mdm/workers', { workerNo: '900028' }, {}, `Bearer ${token}`);
    expect(await guard.canActivate(execution)).toBe(true);
    expect(request.query.plantId).toBe(3);
  });

  it('denies missing bearer, admin token issuance, and account-current to bearer-only devices', async () => {
    const { guard, token } = setup('POP');
    expect(await statusOf(guard.canActivate(context('GET /mdm/workers', { workerNo: '900028' }, {}).execution))).toBe(401);
    expect(await statusOf(guard.canActivate(context('POST /mdm/terminals/{terminalId}:issue-token', {}, { terminalId: '7' }, `Bearer ${token}`).execution))).toBe(401);
    expect(await statusOf(guard.canActivate(context('GET /app/sessions/current', {}, {}, `Bearer ${token}`).execution))).toBe(401);
  });

  it('lets POP and MOBILE read only their own current terminal detail', async () => {
    for (const type of ['POP', 'MOBILE'] as const) {
      const own = setup(type);
      const read = context('GET /mdm/terminals/{terminalId}', {}, { terminalId: '7' }, `Bearer ${own.token}`);
      expect(await own.guard.canActivate(read.execution)).toBe(true);
      expect(currentTerminal(read.request)).toMatchObject({ terminalId: 7n, terminalTypeCode: type });
      expect(await statusOf(own.guard.canActivate(context('GET /mdm/terminals/{terminalId}', {}, { terminalId: '8' }, `Bearer ${own.token}`).execution))).toBe(401);
      for (const stale of [{ version: 3 }, { active: false }, { plantId: 4n }]) {
        const denied = setup(type, stale);
        expect(await statusOf(denied.guard.canActivate(context('GET /mdm/terminals/{terminalId}', {}, { terminalId: '7' }, `Bearer ${own.token}`).execution))).toBe(401);
      }
    }
    // The process map stays POP-only; MOBILE gains the detail row, not work configuration.
    const mobile = setup();
    expect(await statusOf(mobile.guard.canActivate(context('GET /mdm/terminals/{terminalId}/processes', {}, { terminalId: '7' }, `Bearer ${mobile.token}`).execution))).toBe(401);
  });

  it('allows POP inspection items only for its installed same-plant equipment', async () => {
    const { guard, token } = setup('POP');
    expect(await guard.canActivate(context('GET /mdm/equipments/{equipmentId}/inspection-items',
      {}, { equipmentId: '5' }, `Bearer ${token}`).execution)).toBe(true);
    expect(await statusOf(guard.canActivate(context('GET /mdm/equipments/{equipmentId}/inspection-items',
      {}, { equipmentId: '6' }, `Bearer ${token}`).execution))).toBe(401);
  });

  it('denies cross-plant, reissued, inactive, and session-typed bearer tokens', async () => {
    const normal = setup();
    expect(await statusOf(normal.guard.canActivate(context('GET /mdm/workers', { plantId: '4' }, {}, `Bearer ${normal.token}`).execution))).toBe(401);
    const reissued = setup('MOBILE', { version: 3 });
    expect(await statusOf(reissued.guard.canActivate(context('GET /mdm/workers', { plantId: '3' }, {}, `Bearer ${reissued.token}`).execution))).toBe(401);
    const inactive = setup('MOBILE', { active: false });
    expect(await statusOf(inactive.guard.canActivate(context('GET /mdm/workers', { plantId: '3' }, {}, `Bearer ${inactive.token}`).execution))).toBe(401);
    const sessionToken = jwt.sign({ sub: 7, typ: 'session', tv: 2 });
    expect(await statusOf(normal.guard.canActivate(context('GET /mdm/workers', { plantId: '3' }, {}, `Bearer ${sessionToken}`).execution))).toBe(401);
  });

  it('requires a POP work-order lookup to use its installed equipment', async () => {
    const { guard, token } = setup('POP');
    expect(await statusOf(guard.canActivate(context('GET /production/work-orders', { open: 'true', plannedEquipmentId: '6' }, {}, `Bearer ${token}`).execution))).toBe(401);
  });

  it('accepts POP all-view only for open work orders in its mapped process', async () => {
    const { guard, token, prisma } = setup('POP');
    const all = context('GET /production/work-orders', { open: 'true' }, {}, `Bearer ${token}`);
    expect(await guard.canActivate(all.execution)).toBe(true);
    expect(await statusOf(guard.canActivate(context('GET /production/work-orders', { open: 'false' }, {}, `Bearer ${token}`).execution))).toBe(401);
    expect(await guard.canActivate(context('GET /production/work-orders/{workOrderId}', {}, { workOrderId: '11' }, `Bearer ${token}`).execution)).toBe(true);
    expect(prisma.work_order.findFirst).toHaveBeenCalledWith({
      where: { work_order_id: 11n, production_line: { plant_id: 3n },
        released_at: { not: null }, completed_at: null, closed_at: null,
        NOT: { status_code: 'CANCELLED' },
        routing_operation: { process: { terminal_process: {
          some: { terminal_id: 7n, can_start_work: true },
        } } },
      },
      select: { work_order_id: true },
    });
    (prisma.work_order.findFirst as jest.Mock).mockResolvedValueOnce(null);
    expect(await statusOf(guard.canActivate(context('GET /production/work-orders/{workOrderId}', {}, { workOrderId: '12' }, `Bearer ${token}`).execution))).toBe(401);
  });

  it('allows reviewed inventory reads and a real-worker terminal write', async () => {
    const { guard, token } = setup('MOBILE');
    const detail = context('GET /inventory/handling-units/{handlingUnitId}', {},
      { handlingUnitId: '47' }, `Bearer ${token}`);
    expect(await guard.canActivate(detail.execution)).toBe(true);
    expect(currentTerminalInventoryScope(detail.request)).toMatchObject({ plantId: 3n, terminalId: 7n });
    const create = context('POST /inventory/handling-units', {}, {}, `Bearer ${token}`);
    create.request.headers['x-worker-no'] = '900028';
    expect(await guard.canActivate(create.execution)).toBe(true);
    expect(currentTerminalInventoryScope(create.request)).toMatchObject({ workerId: 19n, plantId: 3n });
    expect(await statusOf(guard.canActivate(context('POST /inventory/handling-units', {}, {}, `Bearer ${token}`).execution))).toBe(401);
  });

  it('links POP quality details to its mapped W/O before exposing a plan or nonconformance', async () => {
    const { guard, token, prisma } = setup('POP');
    expect(await guard.canActivate(context('GET /quality/inspection-plan-versions/{inspectionPlanVersionId}',
      {}, { inspectionPlanVersionId: '71' }, `Bearer ${token}`).execution)).toBe(true);
    expect(prisma.inspection_request.findFirst).toHaveBeenCalledWith({
      where: { inspection_plan_version_id: 71n, work_order: {
        production_line: { plant_id: 3n },
        routing_operation: { process: { terminal_process: {
          some: { terminal_id: 7n, can_start_work: true },
        } } },
      } }, select: { inspection_request_id: true },
    });
    (prisma.nonconformance.findFirst as jest.Mock).mockResolvedValueOnce(null);
    expect(await statusOf(guard.canActivate(context('GET /quality/nonconformances/{nonconformanceId}',
      {}, { nonconformanceId: '67' }, `Bearer ${token}`).execution))).toBe(401);
  });

  it('preserves the existing account-session path for administrator operations', async () => {
    const { guard } = setup('MOBILE', { account: true });
    const { request, execution } = context('POST /mdm/terminals/{terminalId}:issue-token', {}, { terminalId: '7' });
    expect(await guard.canActivate(execution)).toBe(true);
    expect(currentSession(request)?.userId).toBe(1);
    expect(currentTerminal(request)).toBeUndefined();
  });

  it('allows only the selected FR-005 batch-01 channel pairs, including q-less item lists', async () => {
    const candidates: Array<[string, 'POP' | 'MOBILE', Record<string, unknown>, Record<string, string>]> = [
      ['GET /mdm/code-values', 'POP', { codeGroupCode: 'LOT_STATUS' }, {}],
      ['GET /mdm/items', 'POP', { includeInactive: 'true' }, {}],
      ['GET /mdm/items/{itemId}', 'POP', {}, { itemId: '41' }],
      ['GET /mdm/molds', 'POP', { q: 'FR005-MOLD' }, {}],
      ['GET /mdm/molds/{moldId}', 'POP', {}, { moldId: '31' }],
      ['GET /mdm/partners', 'POP', { includeInactive: 'true' }, {}],
      ['GET /mdm/code-values', 'MOBILE', { codeGroupCode: 'LOT_STATUS' }, {}],
      ['GET /mdm/equipments', 'MOBILE', { statusCode: 'IN_SERVICE', page: '0' }, {}],
      ['GET /mdm/items', 'MOBILE', { size: '200' }, {}],
      ['GET /mdm/items/{itemId}', 'MOBILE', {}, { itemId: '41' }],
      ['GET /mdm/locations', 'MOBILE', { warehouseId: '29' }, {}],
      ['GET /mdm/locations/{locationId}', 'MOBILE', {}, { locationId: '37' }],
      ['GET /mdm/partners', 'MOBILE', { roleTypeCode: 'SUPPLIER' }, {}],
      ['GET /mdm/partners', 'MOBILE', { roleTypeCode: 'CUSTOMER' }, {}],
      ['GET /mdm/uoms', 'MOBILE', { includeInactive: 'true' }, {}],
    ];
    for (const [key, type, query, params] of candidates) {
      const { guard, token } = setup(type);
      expect(await guard.canActivate(context(key, query, params, `Bearer ${token}`).execution)).toBe(true);
    }
  });

  it('scopes mold and equipment lists and rejects out-of-plant detail IDs', async () => {
    const pop = setup('POP');
    const moldList = context('GET /mdm/molds', { q: 'FR005-MOLD' }, {}, `Bearer ${pop.token}`);
    expect(await pop.guard.canActivate(moldList.execution)).toBe(true);
    expect(moldList.request.query.plantId).toBe(3);
    expect(await statusOf(pop.guard.canActivate(context('GET /mdm/molds', { plantId: '4' }, {}, `Bearer ${pop.token}`).execution))).toBe(401);
    (pop.prisma.mold.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await statusOf(pop.guard.canActivate(context('GET /mdm/molds/{moldId}', {}, { moldId: '31' }, `Bearer ${pop.token}`).execution))).toBe(401);
    expect(pop.prisma.mold.findFirst).toHaveBeenCalledWith({
      where: { mold_id: 31n, plant_id: 3n }, select: { mold_id: true },
    });

    const mobile = setup('MOBILE');
    const equipmentList = context('GET /mdm/equipments', { statusCode: 'IN_SERVICE' }, {}, `Bearer ${mobile.token}`);
    expect(await mobile.guard.canActivate(equipmentList.execution)).toBe(true);
    expect(equipmentList.request.query.plantId).toBe(3);
    (mobile.prisma.location.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await statusOf(mobile.guard.canActivate(context('GET /mdm/locations/{locationId}', {}, { locationId: '37' }, `Bearer ${mobile.token}`).execution))).toBe(401);
    expect(mobile.prisma.location.findFirst).toHaveBeenCalledWith({
      where: { location_id: 37n, warehouse: { plant_id: 3n } }, select: { location_id: true },
    });
    expect(await statusOf(mobile.guard.canActivate(context('GET /mdm/molds', {}, {}, `Bearer ${mobile.token}`).execution))).toBe(401);
  });

  it('limits maintenance reads to the device equipment or its plant', async () => {
    const pop = setup('POP');
    for (const key of ['GET /maintenance/breakdowns', 'GET /maintenance/downtimes',
      'GET /maintenance/downtimes/summary', 'GET /maintenance/inspections']) {
      expect(await pop.guard.canActivate(context(key, { equipmentId: '5' }, {}, `Bearer ${pop.token}`).execution)).toBe(true);
      expect(await statusOf(pop.guard.canActivate(context(key, { equipmentId: '6' }, {}, `Bearer ${pop.token}`).execution))).toBe(401);
    }
    const mobile = setup('MOBILE');
    for (const key of ['GET /maintenance/breakdowns', 'GET /maintenance/inspections']) {
      expect(await mobile.guard.canActivate(context(key, { equipmentId: '6' }, {}, `Bearer ${mobile.token}`).execution)).toBe(true);
    }
    expect(await statusOf(mobile.guard.canActivate(context('GET /maintenance/downtimes', { equipmentId: '5' }, {}, `Bearer ${mobile.token}`).execution))).toBe(401);
    expect(mobile.prisma.equipment.findFirst).toHaveBeenCalledWith({
      where: { equipment_id: 6n, plant_id: 3n }, select: { equipment_id: true },
    });
  });

  it('requires same-plant LOTs for detail, holds, and serial-number list', async () => {
    const pop = setup('POP');
    expect(await pop.guard.canActivate(context('GET /trace/lots/{lotId}', {}, { lotId: '43' }, `Bearer ${pop.token}`).execution)).toBe(true);
    expect(await pop.guard.canActivate(context('GET /trace/serial-numbers', { lotId: '43' }, {}, `Bearer ${pop.token}`).execution)).toBe(true);
    const mobile = setup('MOBILE');
    expect(await mobile.guard.canActivate(context('GET /trace/lots/{lotId}/holds', {}, { lotId: '43' }, `Bearer ${mobile.token}`).execution)).toBe(true);
    expect(mobile.prisma.lot.findFirst).toHaveBeenCalledWith({
      where: { lot_id: 43n, plant_id: 3n }, select: { lot_id: true },
    });
    (mobile.prisma.lot.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await statusOf(mobile.guard.canActivate(context('GET /trace/lots/{lotId}', {}, { lotId: '43' }, `Bearer ${mobile.token}`).execution))).toBe(401);
    expect(await statusOf(pop.guard.canActivate(context('GET /trace/lots/{lotId}/holds', {}, { lotId: '43' }, `Bearer ${pop.token}`).execution))).toBe(401);
  });
});
