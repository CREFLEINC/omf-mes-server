import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { attachSession, TOKEN_TYPE } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { PrismaService } from '../../prisma/prisma.service';
import { documentIssueReportContext } from './document-issue-report-context';

const jwt = new JwtService({
  secret: 'document-report-context-secret-32-characters',
});

describe('발행 결과 보고 context (I-27 P3)', () => {
  it('계정·사번 원문·단말 bigint 문자열·실제 요청을 지문에 담는다', async () => {
    const terminalId = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const context = await documentIssueReportContext(
      createRequest({ terminalToken: token(77) }),
      jwt,
      prismaOf(terminalId),
    );
    expect(context).toMatchObject({
      key: 'idem-1',
      appUserId: 17,
      workerNo: 'W-017',
      terminalId,
      successStatus: 200,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('계정·사번·단말·method/path/query/body 원본이 바뀌면 지문도 달라진다', async () => {
    const baseline = await context(createRequest());
    for (const request of [
      createRequest({ userId: 18 }),
      createRequest({ workerNo: 'W-018' }),
      createRequest({ terminalToken: token(77) }),
      createRequest({ method: 'PUT' }),
      createRequest({ path: '/api/app/document-issues/8:report-print' }),
      createRequest({ query: { source: 'retry' } }),
      createRequest({ body: { outcome: 'FAILED', failureReason: '원문' } }),
    ]) {
      expect((await context(request)).fingerprint).not.toBe(
        baseline.fingerprint,
      );
    }
  });

  it.each([
    [undefined, 'REQUIRED'],
    ['', 'REQUIRED'],
    ['\t\n', 'REQUIRED'],
    [['W-1'], 'REQUIRED'],
    ['W'.repeat(51), 'RANGE'],
  ])('사번 %p를 %s로 거절한다', async (workerNo, code) => {
    await expect(
      context(
        createRequest({ workerNo: workerNo as string | string[] | undefined }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [expect.objectContaining({ field: 'X-Worker-No', code })],
    });
  });

  it('50자 사번은 공백까지 원문 그대로 보존한다', async () => {
    const workerNo = ` ${'W'.repeat(48)} `;
    await expect(context(createRequest({ workerNo }))).resolves.toMatchObject({
      workerNo,
    });
  });

  it('세션이 붙지 않은 요청은 401이다', async () => {
    await expect(
      context(createRequest({ attach: false })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('온 단말 토큰이 유효하지 않으면 context 단계에서 400이다', async () => {
    await expect(
      context(
        createRequest({ terminalToken: jwt.sign({ sub: 77, typ: 'session' }) }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        expect.objectContaining({ field: 'Authorization', code: 'INVALID' }),
      ],
    });
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  method?: string;
  path?: string;
  query?: object;
  terminalToken?: string;
  userId?: number;
  workerNo?: string | string[];
}

function createRequest(options: RequestOptions = {}): Request {
  const headers: Record<string, string | string[]> = {
    'idempotency-key': 'idem-1',
  };
  if (Object.prototype.hasOwnProperty.call(options, 'workerNo')) {
    if (options.workerNo !== undefined)
      headers['x-worker-no'] = options.workerNo;
  } else {
    headers['x-worker-no'] = 'W-017';
  }
  if (options.terminalToken)
    headers.authorization = `Bearer ${options.terminalToken}`;
  const request = {
    method: options.method ?? 'POST',
    path: options.path ?? '/api/app/document-issues/7:report-print',
    headers,
    body: options.body ?? { outcome: 'SUCCEEDED' },
    query: options.query ?? {},
  } as unknown as Request;
  if (options.attach !== false) {
    attachSession(request, { userId: options.userId ?? 17 } as Session);
  }
  return request;
}

function token(terminalId: number): string {
  return jwt.sign({ sub: terminalId, typ: TOKEN_TYPE.TERMINAL, tv: 1 });
}

function prismaOf(terminalId: bigint = 77n): PrismaService {
  return {
    terminal: {
      findUnique: jest.fn().mockResolvedValue({
        terminal_id: terminalId,
        is_active: true,
        token_version: 1,
      }),
    },
  } as unknown as PrismaService;
}

function context(request: Request) {
  return documentIssueReportContext(request, jwt, prismaOf());
}
