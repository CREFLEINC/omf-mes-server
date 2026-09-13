import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { assertTerminalAppReadScope, currentTerminalApprovalListScope } from './terminal-app-read-scope';

const terminal = { terminalId: 7n, terminalCode: 'POP-7', plantId: 3n,
  terminalTypeCode: 'POP', equipmentId: 5n };

function request(query: Record<string, unknown> = {}, params: Record<string, string> = {}): Request {
  return { query, params, headers: {} } as unknown as Request;
}

describe('POP app read scope', () => {
  const prisma = {
    lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
    serial_number: { findFirst: jest.fn().mockResolvedValue({ serial_number_id: 51n }) },
    handling_unit: { findUnique: jest.fn().mockResolvedValue({ warehouse: { plant_id: 3n }, location: null }) },
    goods_issue_line: { findFirst: jest.fn().mockResolvedValue({ goods_issue_line_id: 61n }) },
    document_issue_log: { findUnique: jest.fn().mockResolvedValue({
      document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: 43n,
    }) },
    shipment_lot_allocation: { findFirst: jest.fn().mockResolvedValue({ shipment_lot_allocation_id: 71n }) },
  } as unknown as PrismaService;

  it('checks every summary target and denies a foreign one', async () => {
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'LOT', targetIds: ['43', '44'] }),
      'GET /app/document-issues/summary', terminal)).resolves.toBeUndefined();
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'LOT', targetIds: ['44'] }),
      'GET /app/document-issues/summary', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('requires a target for issue history and the owned target for a rendition', async () => {
    await expect(assertTerminalAppReadScope(prisma, request(),
      'GET /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '9' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).resolves.toBeUndefined();
    (prisma.document_issue_log.findUnique as jest.Mock).mockResolvedValueOnce({
      document_type_code: 'PACKING_LABEL', target_type_code: 'LOT', target_id: 43n,
    });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '9' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('binds printer lookup to the current terminal and policy lookup to global scope', async () => {
    await expect(assertTerminalAppReadScope(prisma, request({ documentTypeCode: 'GOODS_ISSUE_QR' }),
      'GET /app/printers', terminal)).resolves.toBeUndefined();
    await expect(assertTerminalAppReadScope(prisma, request({ terminalId: '8' }),
      'GET /app/printers', terminal)).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalAppReadScope(prisma, request({ policyCode: 'SHOT_CONVERSION_RATIO' }),
      'GET /app/operation-policies/effective', terminal)).resolves.toBeUndefined();
    await expect(assertTerminalAppReadScope(prisma, request({ policyCode: 'SHOT_CONVERSION_RATIO', plantId: '8' }),
      'GET /app/operation-policies/effective', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('requires both HU warehouse and location to belong to the terminal plant', async () => {
    (prisma.handling_unit.findUnique as jest.Mock).mockResolvedValueOnce({
      warehouse: { plant_id: 3n }, location: { warehouse: { plant_id: 4n } },
    });
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'HANDLING_UNIT', targetId: '55' }),
      'GET /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('allows only an owned delivery allocation rendition', async () => {
    (prisma.document_issue_log.findUnique as jest.Mock).mockResolvedValueOnce({
      document_type_code: 'DELIVERY_LABEL', target_type_code: 'SHIPMENT_LOT_ALLOCATION', target_id: 71n,
    });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '10' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).resolves.toBeUndefined();
    (prisma.shipment_lot_allocation.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'SHIPMENT_LOT_ALLOCATION', targetId: '71' }),
      'GET /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
  });
});

describe('MOBILE approval list scope', () => {
  const mobile = { ...terminal, terminalTypeCode: 'MOBILE' };
  const prisma = {
    lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 9n }) },
  } as unknown as PrismaService;

  it('binds the pending query to an inbound LOT in the terminal plant', async () => {
    const req = request({ targetTypeCode: 'INBOUND_LOT', targetId: '43', pendingOnly: 'true', size: '1' });
    await assertTerminalAppReadScope(prisma, req, 'GET /app/approval-requests', mobile);
    expect(currentTerminalApprovalListScope(req)).toEqual({ plantId: 3n, lotId: 43n });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma, request({ targetTypeCode: 'INBOUND_LOT', targetId: '44', pendingOnly: 'true', size: '1' }),
      'GET /app/approval-requests', mobile)).rejects.toMatchObject({ status: 401 });
  });

  it('requires an active same-plant worker for my requests', async () => {
    const req = request({ requestedByMe: 'true', size: '20' });
    req.headers = { 'x-worker-no': 'W-9' };
    await assertTerminalAppReadScope(prisma, req, 'GET /app/approval-requests', mobile);
    expect(currentTerminalApprovalListScope(req)).toEqual({ plantId: 3n, workerId: 9n });
    await expect(assertTerminalAppReadScope(prisma, request({ requestedByMe: 'true' }),
      'GET /app/approval-requests', mobile)).rejects.toMatchObject({ status: 401 });
  });
});
