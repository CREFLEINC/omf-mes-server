import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import { assertTerminalLotWriteScope, currentTerminalLotWorkerId } from './terminal-lot-write-scope';

const terminal: TerminalContext = {
  terminalId: 7n, terminalCode: 'M-7', terminalTypeCode: 'MOBILE', plantId: 3n, equipmentId: null,
};
const prisma = () => ({
  worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 23n }) },
  inbound_receipt_line: { findFirst: jest.fn().mockResolvedValue({ inbound_receipt_line_id: 11n }) },
  lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 12n }) },
}) as unknown as PrismaService;
const request = (body: object, lotId?: string) => ({
  headers: { 'x-worker-no': 'W-23', 'idempotency-key': 'lot-1' },
  body, params: { lotId },
}) as unknown as Request;

it('limits new material LOTs to unassigned receipt lines in the terminal plant', async () => {
  const db = prisma();
  const req = request({ plantId: 3, sourceTypeCode: 'INBOUND_RECEIPT_LINE', sourceId: 11 });
  await assertTerminalLotWriteScope(db, req, 'POST /trace/lots', terminal);
  expect(currentTerminalLotWorkerId(req)).toBe(23n);
  expect(db.inbound_receipt_line.findFirst).toHaveBeenCalledWith({ where: {
    inbound_receipt_line_id: 11n, inbound_receipt: { plant_id: 3n }, lot_id: null,
  }, select: { inbound_receipt_line_id: true } });
  await expect(assertTerminalLotWriteScope(db, request({ plantId: 4,
    sourceTypeCode: 'INBOUND_RECEIPT_LINE', sourceId: 11 }), 'POST /trace/lots', terminal))
    .rejects.toHaveProperty('status', 401);
});

it('limits IQC skip to an inbound LOT in the terminal plant', async () => {
  const db = prisma();
  await assertTerminalLotWriteScope(db, request({}, '12'), 'POST /trace/lots/{lotId}:request-iqc-skip', terminal);
  expect(db.lot.findFirst).toHaveBeenCalledWith({ where: {
    lot_id: 12n, plant_id: 3n, source_type_code: 'INBOUND_RECEIPT_LINE',
  }, select: { lot_id: true } });
  (db.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
  await expect(assertTerminalLotWriteScope(db, request({}, '13'),
    'POST /trace/lots/{lotId}:request-iqc-skip', terminal)).rejects.toHaveProperty('status', 401);
});
