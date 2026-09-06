import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { ERROR_CODE, field, one } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TOKEN_TYPE } from './session-resolver.service';

/**
 * `Authorization: Bearer <단말 토큰>` 을 `terminal_id` 로 푼다.
 *
 * 계약이 `terminalToken` 을 정의만 하고 `security` 를 어디에도 안 걸었다 — 인증은 계정
 * 세션이 지고 이 파일은 **값의 출처 + 게이팅 판정 입력**으로만 읽는다(I-11 §2-2 ⓑ · R-2).
 * ⛔ `AuthenticationGuard`·`Session` 타입을 고치지 않는다. 설계 미정 — 문의 054.
 */

/** 계약 `terminalToken` 이 실리는 자리. 화면이 「인증」 축으로 적은 그 헤더다(`P-CO-01` §5-4). */
const AUTHORIZATION = 'Authorization';
const BEARER = /^Bearer\s+(\S+)$/;

/** `terminal.service.ts:215` 가 서명해 넣는 클레임 셋. */
interface TerminalTokenClaims {
  sub: number;
  typ: string;
  tv: number;
}

/**
 * 헤더가 **없으면 `null`** 이다 — 던지지 않는다. 「없음」과 「틀림」은 다르고(`M-CO-01` §6),
 * 「없음」을 어떻게 다룰지는 오퍼레이션이 정한다(세션 열기만 403 · R-1).
 * 온 경우에만 서명·종류·행 존재·활성·세대를 보고 어긋나면 400 `INVALID` 다.
 */
export async function resolveTerminalId(
  jwt: JwtService,
  prisma: PrismaService,
  request: Request,
): Promise<bigint | null> {
  const raw = request.headers.authorization;
  if (raw === undefined || raw.trim() === '') return null;

  const matched = BEARER.exec(raw.trim());
  if (matched === null) throw invalidToken();

  const claims = await verify(jwt, matched[1]);
  // ⛔ 종류를 본다 — 세션 쿠키와 같은 비밀키라 종류가 없으면 계정 토큰이 단말로 풀린다.
  if (claims.typ !== TOKEN_TYPE.TERMINAL) throw invalidToken();

  const terminal = await prisma.terminal.findUnique({
    where: { terminal_id: BigInt(claims.sub) },
    select: { terminal_id: true, is_active: true, token_version: true },
  });
  // 재발급이 `token_version` 을 올린다 — 옛 기기의 토큰은 여기서 끊긴다(공유계약 F-4).
  if (terminal === null || !terminal.is_active || terminal.token_version !== claims.tv) {
    throw invalidToken();
  }
  return terminal.terminal_id;
}

async function verify(jwt: JwtService, token: string): Promise<TerminalTokenClaims> {
  try {
    return await jwt.verifyAsync<TerminalTokenClaims>(token);
  } catch {
    throw invalidToken();
  }
}

/** 만료·위조·낡음을 가르지 않는다 — 화면이 할 일은 하나(재발급)라 문구도 하나다. */
function invalidToken() {
  return one(field(AUTHORIZATION, ERROR_CODE.INVALID, '단말 토큰이 유효하지 않습니다 — 재발급이 필요합니다.'));
}
