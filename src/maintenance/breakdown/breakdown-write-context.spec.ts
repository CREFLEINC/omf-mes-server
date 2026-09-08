import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { attachSession } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { breakdownWriteContext } from './breakdown-write-context';

describe('breakdown write context', () => {
  it('세션 주체·사번 원문·201을 지문에 담는다', () => {
    expect(breakdownWriteContext(createRequest())).toMatchObject({
      key: 'idem-1',
      appUserId: 17,
      workerNo: 'W-017',
      successStatus: 201,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('세션·사번·본문·오퍼레이션이 달라지면 지문도 달라진다', () => {
    const baseline = breakdownWriteContext(createRequest()).fingerprint;
    for (const request of [
      createRequest({ userId: 18 }),
      createRequest({ workerNo: 'W-018' }),
      createRequest({ body: { equipmentId: 8 } }),
      createRequest({ path: '/maintenance/other' }),
      createRequest({ method: 'PUT' }),
    ]) {
      expect(breakdownWriteContext(request).fingerprint).not.toBe(baseline);
    }
  });

  it.each([
    [undefined, 'REQUIRED'],
    ['', 'REQUIRED'],
    ['   ', 'REQUIRED'],
    ['W'.repeat(51), 'INVALID'],
  ])('사번 %p를 %s로 거절한다', (workerNo, code) => {
    expect(() => breakdownWriteContext(createRequest({ workerNo }))).toThrow(
      expect.objectContaining({
        status: 400,
        errors: [expect.objectContaining({ field: 'X-Worker-No', code })],
      }),
    );
  });

  it('50자 사번은 공백까지 원문 그대로 보존한다', () => {
    const workerNo = ` ${'W'.repeat(48)} `;
    expect(breakdownWriteContext(createRequest({ workerNo })).workerNo).toBe(
      workerNo,
    );
  });

  it('세션이 붙지 않은 요청은 401이다', () => {
    expect(() =>
      breakdownWriteContext(createRequest({ attach: false })),
    ).toThrow(UnauthorizedException);
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  method?: string;
  path?: string;
  userId?: number;
  workerNo?: string;
}

function createRequest(options: RequestOptions = {}): Request {
  const headers: Record<string, string> = { 'idempotency-key': 'idem-1' };
  const workerNo = Object.prototype.hasOwnProperty.call(options, 'workerNo')
    ? options.workerNo
    : 'W-017';
  if (workerNo !== undefined) headers['x-worker-no'] = workerNo;
  const request = {
    method: options.method ?? 'POST',
    path: options.path ?? '/maintenance/breakdowns',
    headers,
    body: options.body ?? { equipmentId: 7 },
  } as unknown as Request;
  if (options.attach !== false) {
    attachSession(request, { userId: options.userId ?? 17 } as Session);
  }
  return request;
}
