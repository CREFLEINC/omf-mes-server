import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { CONTRACT_OPERATION } from '../common/contract';
import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { SessionResolver, attachSession } from './session-resolver.service';
import { attachTerminal } from './terminal-context';
import { TERMINAL_READ_OPERATIONS, assertTerminalReadScope } from './terminal-read-policy';
import { TERMINAL_PRODUCTION_OPERATIONS, assertTerminalProductionScope } from './terminal-production-scope';
import { TERMINAL_INVENTORY_OPERATIONS, assertTerminalInventoryScope } from './terminal-inventory-scope';
import { TERMINAL_LOGISTICS_OPERATIONS, assertTerminalLogisticsScope } from './terminal-logistics-scope';
import { TERMINAL_MAINTENANCE_OPERATIONS, assertTerminalMaintenanceScope } from './terminal-maintenance-scope';
import { TERMINAL_APP_READ_OPERATIONS, assertTerminalAppReadScope } from './terminal-app-read-scope';
import { TERMINAL_APP_WRITE_OPERATIONS, assertTerminalAppWriteScope } from './terminal-app-write-scope';
import { TERMINAL_QUALITY_READ_OPERATIONS, assertTerminalQualityReadScope } from './terminal-quality-read-scope';
import { TERMINAL_QUALITY_WRITE_OPERATIONS, assertTerminalQualityWriteScope } from './terminal-quality-write-scope';
import { TERMINAL_MOBILE_PRODUCTION_OPERATIONS, assertTerminalMobileProductionScope } from './terminal-mobile-production-scope';
import { TERMINAL_LOT_WRITE_OPERATIONS, assertTerminalLotWriteScope } from './terminal-lot-write-scope';
import { resolveTerminalContext } from './terminal-token';

/**
 * 인증 없이 도는 오퍼레이션. **로그인 하나뿐이다.**
 *
 * ⛔ 로그인을 면제하지 않으면 순환이다 — 권한은 세션에서 나오는데 세션은 로그인이 만든다.
 * 요구서 §3 이 `POST /app/sessions` 를 `W-CO-01`(계정 로그인) 화면에 걸어 두었으나,
 * 그것은 «화면»이 그 경로를 부른다는 뜻이지 권한을 요구한다는 뜻이 아니다.
 */
const ANONYMOUS = new Set(['POST /app/sessions']);

/**
 * 계약에 묶인 오퍼레이션은 세션이 있어야 돈다.
 *
 * ⛔ 계약 검증 가드 «앞»에 선다. 뒤에 서면 인증 안 된 호출자가 401 대신 400 과 함께
 * 계약 스키마의 생김새를 돌려받는다.
 *
 * 단말 토큰은 명시된 오퍼레이션과 DB 자원 범위에만 허용한다. 관리자·미등록 경로는 세션 전용이다.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: SessionResolver,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.get<string | undefined>(CONTRACT_OPERATION, context.getHandler());
    // 계약에 묶이지 않은 자리(헬스체크 등)는 이 가드의 대상이 아니다.
    if (!key || ANONYMOUS.has(key)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.resolver.resolve(request);
    if (session) {
      attachSession(request, session);
      return true;
    }

    const inventoryTypes = TERMINAL_INVENTORY_OPERATIONS[key];
    // Logistics owns its full route-specific resource and query predicates,
    // including the few GET keys formerly listed in the FR-004 read policy.
    const terminalTypes = TERMINAL_LOGISTICS_OPERATIONS[key] ?? TERMINAL_QUALITY_READ_OPERATIONS[key]
      ?? TERMINAL_READ_OPERATIONS[key]
      ?? TERMINAL_PRODUCTION_OPERATIONS[key] ?? inventoryTypes
      ?? TERMINAL_MAINTENANCE_OPERATIONS[key] ?? TERMINAL_APP_READ_OPERATIONS[key]
      ?? TERMINAL_APP_WRITE_OPERATIONS[key] ?? TERMINAL_QUALITY_WRITE_OPERATIONS[key]
      ?? TERMINAL_MOBILE_PRODUCTION_OPERATIONS[key] ?? TERMINAL_LOT_WRITE_OPERATIONS[key];
    if (!terminalTypes || !request.headers.authorization) throw loginRequired();
    let terminal;
    try {
      terminal = await resolveTerminalContext(this.jwt, this.prisma, request);
    } catch (error) {
      if (!(error instanceof ContractException)) throw error;
      throw loginRequired();
    }
    if (!terminal || !terminalTypes.includes(terminal.terminalTypeCode as 'POP' | 'MOBILE'))
      throw loginRequired();
    if (TERMINAL_LOGISTICS_OPERATIONS[key]) await assertTerminalLogisticsScope(this.prisma, request, key, terminal);
    else if (TERMINAL_QUALITY_READ_OPERATIONS[key]) await assertTerminalQualityReadScope(this.prisma, request, key, terminal);
    else if (TERMINAL_READ_OPERATIONS[key]) await assertTerminalReadScope(this.prisma, request, key, terminal);
    else if (TERMINAL_PRODUCTION_OPERATIONS[key]) await assertTerminalProductionScope(this.prisma, request, key, terminal);
    else if (inventoryTypes) await assertTerminalInventoryScope(this.prisma, request, key, terminal);
    else if (TERMINAL_MAINTENANCE_OPERATIONS[key]) await assertTerminalMaintenanceScope(this.prisma, request, key, terminal);
    else if (TERMINAL_QUALITY_WRITE_OPERATIONS[key]) await assertTerminalQualityWriteScope(this.prisma, request, key, terminal);
    else if (TERMINAL_MOBILE_PRODUCTION_OPERATIONS[key]) await assertTerminalMobileProductionScope(this.prisma, request, key, terminal);
    else if (TERMINAL_LOT_WRITE_OPERATIONS[key]) await assertTerminalLotWriteScope(this.prisma, request, key, terminal);
    else if (TERMINAL_APP_READ_OPERATIONS[key]) await assertTerminalAppReadScope(this.prisma, request, key, terminal);
    else await assertTerminalAppWriteScope(this.prisma, request, key, terminal);
    attachTerminal(request, terminal);
    return true;
  }
}

function loginRequired(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '로그인이 필요합니다.' },
  ]);
}
