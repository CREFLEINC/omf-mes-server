import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { attachTerminal } from '../../auth/terminal-context';
import { PrismaService } from '../../prisma/prisma.service';
import { serialNumberWriteContext } from './serial-number-write-context';

describe('serialNumberWriteContext for POP', () => {
  const jwt = { verifyAsync: jest.fn().mockResolvedValue({
    sub: 7, typ: 'terminal', tv: 2, terminalCode: 'POP-7', plantId: 3,
  }) } as unknown as JwtService;
  const prisma = {
    terminal: { findUnique: jest.fn().mockResolvedValue({
      terminal_id: 7n, terminal_code: 'POP-7', plant_id: 3n, terminal_type_code: 'POP',
      equipment_id: 5n, is_active: true, token_version: 2,
    }) },
    worker: { findFirst: jest.fn().mockResolvedValue({ app_user_id: null }) },
  } as unknown as PrismaService;

  function request(): Request {
    const req = { method: 'POST', path: '/trace/serial-numbers', body: { lotId: 43, quantity: 2 },
      headers: { authorization: 'Bearer terminal-token', 'x-worker-no': '900028',
        'idempotency-key': 'serial-1' } } as unknown as Request;
    attachTerminal(req, { terminalId: 7n, terminalCode: 'POP-7', plantId: 3n,
      terminalTypeCode: 'POP', equipmentId: 5n });
    return req;
  }

  it('accepts an active same-plant worker without borrowing an administrator session', async () => {
    const result = await serialNumberWriteContext(request(), jwt, prisma);
    expect(result).toMatchObject({ workerNo: '900028', terminalId: 7n, successStatus: 201 });
    expect(result.appUserId).toBeUndefined();
    expect(prisma.worker.findFirst).toHaveBeenCalledWith({
      where: { worker_no: '900028', plant_id: 3n, is_active: true },
      select: { app_user_id: true },
    });
  });

  it('rejects a worker absent from the terminal plant', async () => {
    (prisma.worker.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(serialNumberWriteContext(request(), jwt, prisma))
      .rejects.toMatchObject({ status: 401 });
  });
});
