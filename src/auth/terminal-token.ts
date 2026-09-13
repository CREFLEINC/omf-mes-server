import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { ERROR_CODE, field, one } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TOKEN_TYPE } from './session-resolver.service';
import { TerminalContext } from './terminal-context';

/**
 * `Authorization: Bearer <단말 토큰>` → `terminal_id`.
 *
 * `AuthenticationGuard` 는 FR-004 에서 선정한 단말 조회 경로에 한해 이 값을 인증한다.
 * 단말 컨텍스트는 계정 세션과 분리하고, 권한은 허용 경로와 DB 자원 범위로 제한한다.
 *
 * 헤더가 없으면 `null` 이다. 온 경우에 서명·종류·행 존재·`is_active`·
 * `token_version` 을 검사한다. 이 함수의 오류는 호출부 계약에 따라 처리하며,
 * `AuthenticationGuard` 는 인증 실패를 401로 변환한다.
 */
const BEARER = /^Bearer\s+(\S+)$/;
/** `terminal.service.ts:215` 가 서명해 넣는 클레임 셋. */
interface TerminalTokenClaims {
  sub: number;
  typ: string;
  tv: number;
  terminalCode?: string;
  plantId?: number;
}
export async function resolveTerminalId(jwt: JwtService, prisma: PrismaService, request: Request): Promise<bigint | null> {
  const terminal = await resolveTerminalContext(jwt, prisma, request);
  return terminal?.terminalId ?? null;
}

export async function resolveTerminalContext(jwt: JwtService, prisma: PrismaService, request: Request): Promise<TerminalContext | null> {
  const raw = request.headers.authorization;
  if (raw === undefined || raw.trim() === '') return null;
  const matched = BEARER.exec(raw.trim());
  if (matched === null) throw invalidToken();
  const claims = await jwt.verifyAsync<TerminalTokenClaims>(matched[1]).catch(() => {
    throw invalidToken();
  });
  // ⛔ 종류를 본다 — 세션 쿠키와 같은 비밀키라 종류가 없으면 계정 토큰이 단말로 풀린다.
  if (claims.typ !== TOKEN_TYPE.TERMINAL || !Number.isSafeInteger(claims.sub) || claims.sub <= 0
    || !Number.isSafeInteger(claims.tv)) throw invalidToken();
  const terminal = await prisma.terminal.findUnique({
    where: { terminal_id: BigInt(claims.sub) },
    select: { terminal_id: true, terminal_code: true, plant_id: true, terminal_type_code: true,
      equipment_id: true, is_active: true, token_version: true },
  });
  // 재발급이 `token_version` 을 올린다 — 옛 기기의 토큰은 여기서 끊긴다(공유계약 F-4).
  if (terminal === null || !terminal.is_active || terminal.token_version !== claims.tv) throw invalidToken();
  if ((claims.terminalCode !== undefined && claims.terminalCode !== terminal.terminal_code)
    || (claims.plantId !== undefined && claims.plantId !== Number(terminal.plant_id))) throw invalidToken();
  return {
    terminalId: terminal.terminal_id,
    terminalCode: terminal.terminal_code,
    plantId: terminal.plant_id,
    terminalTypeCode: terminal.terminal_type_code,
    equipmentId: terminal.equipment_id,
  };
}

/** 만료·위조·낡음을 가르지 않는다 — 화면이 할 일은 하나(재발급)라 문구도 하나다. */
function invalidToken() {
  return one(field('Authorization', ERROR_CODE.INVALID, '단말 토큰이 유효하지 않습니다 — 재발급이 필요합니다.'));
}
