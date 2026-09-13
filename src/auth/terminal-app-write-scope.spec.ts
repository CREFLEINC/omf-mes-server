import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';
import { assertTerminalAppWriteScope, TERMINAL_APP_WRITE_OPERATIONS } from './terminal-app-write-scope';

const terminal: TerminalContext = {
  terminalId: 7n, terminalCode: 'POP-7', plantId: 3n,
  terminalTypeCode: 'POP', equipmentId: 5n,
};

function fixture() {
  const owned = jest.fn().mockResolvedValue({ shipment_lot_allocation_id: 42n });
  const issue = jest.fn().mockResolvedValue({
    target_type_code: 'SHIPMENT_LOT_ALLOCATION', target_id: 42n, terminal_id: 7n,
  });
  const prisma = {
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 19n }) },
    shipment_lot_allocation: { findFirst: owned },
    document_issue_log: { findUnique: issue },
  } as unknown as PrismaService;
  const request = {
    headers: { 'x-worker-no': '900028' },
    params: { documentIssueLogId: '81' },
    body: { targets: [{ targetTypeCode: 'SHIPMENT_LOT_ALLOCATION', targetId: 42 }] },
  } as unknown as Request;
  return { prisma, request, owned, issue };
}

describe('POP document issue terminal scope', () => {
  it('enumerates only issue and print report writes', () => {
    expect(Object.keys(TERMINAL_APP_WRITE_OPERATIONS)).toEqual([
      'POST /app/document-issues',
      'POST /app/document-issues/{documentIssueLogId}:report-print',
    ]);
  });

  it('allows a mapped active worker only on an owned delivery allocation', async () => {
    const { prisma, request, owned } = fixture();
    await expect(assertTerminalAppWriteScope(prisma, request,
      'POST /app/document-issues', terminal)).resolves.toBeUndefined();
    expect(owned).toHaveBeenCalledWith({ where: {
      shipment_lot_allocation_id: 42n,
      shipment_line: { shipment: { warehouse: { plant_id: 3n } } },
    }, select: { shipment_lot_allocation_id: true } });
    owned.mockResolvedValue(null);
    await expect(assertTerminalAppWriteScope(prisma, request,
      'POST /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('denies another terminal print log before any business update', async () => {
    const { prisma, request, issue } = fixture();
    issue.mockResolvedValue({ target_type_code: 'SHIPMENT_LOT_ALLOCATION',
      target_id: 42n, terminal_id: 8n });
    await expect(assertTerminalAppWriteScope(prisma, request,
      'POST /app/document-issues/{documentIssueLogId}:report-print', terminal))
      .rejects.toMatchObject({ status: 401 });
  });
});
