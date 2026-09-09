import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { IdempotencyService } from '../idempotency';
import { runIdempotent } from './master-write';

describe('마스터 멱등 쓰기', () => {
  it('업무 콜백에 멱등 기록과 같은 트랜잭션을 전달한다', async () => {
    const tx = { marker: 'same-transaction' } as unknown as Prisma.TransactionClient;
    const idempotency = {
      run: async (
        _context: unknown,
        work: (received: Prisma.TransactionClient) => Promise<unknown>,
      ) => ({ replayed: false, status: 200, body: await work(tx) }),
    } as unknown as IdempotencyService;
    const request = {
      headers: { 'idempotency-key': 'master-write-tx' },
      method: 'POST',
      path: '/mdm/example',
      body: { value: 1 },
    } as unknown as Request;
    let received: Prisma.TransactionClient | undefined;

    const result = await runIdempotent(idempotency, request, 200, async (workTx) => {
      received = workTx;
      return 'done';
    });

    expect(result).toBe('done');
    expect(received).toBe(tx);
  });
});
