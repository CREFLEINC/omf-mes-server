import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import { assertTerminalQualityWriteScope, currentTerminalQualityWorkerId } from './terminal-quality-write-scope';

const terminal: TerminalContext = {
  terminalId: 7n, terminalCode: 'POP-7', terminalTypeCode: 'POP', plantId: 3n, equipmentId: 4n,
};
const request = (inspectionRequestId: number) => ({
  headers: { 'x-worker-no': 'W-23', 'idempotency-key': 'quality-1' },
  body: { inspectionRequestId },
}) as unknown as Request;
const prisma = () => ({
  worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 23n }) },
  inspection_request: { findFirst: jest.fn().mockResolvedValue({ inspection_request_id: 11n }) },
}) as unknown as PrismaService;

it('permits an active worker and inspection request tied to the POP process in the same plant', async () => {
  const db = prisma();
  const req = request(11);
  await assertTerminalQualityWriteScope(db, req, 'POST /quality/inspection-results', terminal);
  expect(currentTerminalQualityWorkerId(req)).toBe(23n);
  expect(db.inspection_request.findFirst).toHaveBeenCalledWith({ where: {
    inspection_request_id: 11n,
    work_order: { production_line: { plant_id: 3n }, routing_operation: { process: {
      terminal_process: { some: { terminal_id: 7n, can_start_work: true } },
    } } },
  }, select: { inspection_request_id: true } });
});

it('rejects a request outside the terminal process and wrong terminal type', async () => {
  const db = prisma();
  (db.inspection_request.findFirst as jest.Mock).mockResolvedValueOnce(null);
  await expect(assertTerminalQualityWriteScope(db, request(11), 'POST /quality/inspection-results', terminal))
    .rejects.toHaveProperty('status', 401);
  await expect(assertTerminalQualityWriteScope(db, request(11), 'POST /quality/inspection-results', {
    ...terminal, terminalTypeCode: 'MOBILE',
  })).rejects.toHaveProperty('status', 401);
});

/** P-02-14 자재 불량 등록(장부 P-52) — 자재 불량 원천 · 단말 공장 LOT 만. */
describe('POP material defect and hold', () => {
  const db = (ownedLots: number) => ({
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 23n }) },
    lot: { count: jest.fn().mockResolvedValue(ownedLots) },
  }) as unknown as PrismaService;
  const req = (body: Record<string, unknown>) => ({
    headers: { 'x-worker-no': 'W-23', 'idempotency-key': 'quality-2' }, body,
  }) as unknown as Request;

  it('records a MATERIAL defect for a LOT of the terminal plant and attaches the worker', async () => {
    const prisma = db(1);
    const request = req({ sourceCode: 'MATERIAL', lotId: 31 });
    await assertTerminalQualityWriteScope(prisma, request, 'POST /quality/defect-records', terminal);
    expect(currentTerminalQualityWorkerId(request)).toBe(23n);
    expect(prisma.lot.count).toHaveBeenCalledWith({ where: { lot_id: { in: [31n] }, plant_id: 3n } });
  });

  it('rejects other defect sources, missing LOT and LOTs of another plant', async () => {
    await expect(assertTerminalQualityWriteScope(db(1), req({ sourceCode: 'PQC', lotId: 31 }),
      'POST /quality/defect-records', terminal)).rejects.toHaveProperty('status', 401);
    await expect(assertTerminalQualityWriteScope(db(1), req({ sourceCode: 'MATERIAL' }),
      'POST /quality/defect-records', terminal)).rejects.toHaveProperty('status', 401);
    await expect(assertTerminalQualityWriteScope(db(0), req({ sourceCode: 'MATERIAL', lotId: 31 }),
      'POST /quality/defect-records', terminal)).rejects.toHaveProperty('status', 401);
  });

  it('holds only when every LOT belongs to the terminal plant', async () => {
    await assertTerminalQualityWriteScope(db(2), req({ lots: [{ lotId: 31 }, { lotId: 32 }] }),
      'POST /quality/lot-holds', terminal);
    await expect(assertTerminalQualityWriteScope(db(1), req({ lots: [{ lotId: 31 }, { lotId: 32 }] }),
      'POST /quality/lot-holds', terminal)).rejects.toHaveProperty('status', 401);
    await expect(assertTerminalQualityWriteScope(db(0), req({ lots: [] }),
      'POST /quality/lot-holds', terminal)).rejects.toHaveProperty('status', 401);
  });
});
