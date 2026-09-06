import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { ContractException } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TOKEN_TYPE } from './session-resolver.service';
import { resolveTerminalId } from './terminal-token';

const SECRET = 'terminal-token-spec-secret-32자리이상을-채운다';
const TERMINAL_ID = 77;

const jwt = new JwtService({ secret: SECRET });

function prismaOf(row: { is_active: boolean; token_version: number } | null): PrismaService {
  return {
    terminal: {
      findUnique: () =>
        Promise.resolve(row === null ? null : { terminal_id: BigInt(TERMINAL_ID), ...row }),
    },
  } as unknown as PrismaService;
}

function requestOf(token: string | undefined): Request {
  return { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } } as Request;
}

async function rejection(promise: Promise<unknown>): Promise<ContractException> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(ContractException);
  return caught as ContractException;
}

describe('resolveTerminalId', () => {
  it('종류가 session 인 토큰이면 400 INVALID', async () => {
    // 설계 미정 — 문의 054
    const token = await jwt.signAsync({ sub: TERMINAL_ID, typ: TOKEN_TYPE.SESSION, tv: 1 });
    const error = await rejection(
      resolveTerminalId(jwt, prismaOf({ is_active: true, token_version: 1 }), requestOf(token)),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({ field: 'Authorization', code: 'INVALID' }),
    ]);
    expect(error.getStatus()).toBe(400);
  });

  it('token_version 이 어긋나면 400 INVALID', async () => {
    // 설계 미정 — 문의 054
    const token = await jwt.signAsync({ sub: TERMINAL_ID, typ: TOKEN_TYPE.TERMINAL, tv: 1 });
    const error = await rejection(
      resolveTerminalId(jwt, prismaOf({ is_active: true, token_version: 2 }), requestOf(token)),
    );
    expect(error.errors[0]).toMatchObject({ code: 'INVALID' });
  });

  it('비활성 단말이면 400 INVALID', async () => {
    // 설계 미정 — 문의 054
    const token = await jwt.signAsync({ sub: TERMINAL_ID, typ: TOKEN_TYPE.TERMINAL, tv: 3 });
    const error = await rejection(
      resolveTerminalId(jwt, prismaOf({ is_active: false, token_version: 3 }), requestOf(token)),
    );
    expect(error.errors[0]).toMatchObject({ code: 'INVALID' });
  });

  it('헤더가 없으면 null 을 낸다(던지지 않는다)', async () => {
    // 설계 미정 — 문의 054
    const resolved = await resolveTerminalId(jwt, prismaOf(null), requestOf(undefined));
    expect(resolved).toBeNull();
  });
});
