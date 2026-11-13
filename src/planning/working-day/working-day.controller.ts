import { Body, Controller, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { PrismaService } from '../../prisma/prisma.service';
import { scopedPlantIds } from '../production-order/production-order-scope';
import { WorkingDayResolveBody, WorkingDayResolveResult, resolveTargets } from './working-day-resolve';

/** 계획 화면의 자동 분배·분할이 날짜를 고르기 전에 근무일을 묻는다 — 읽기만 한다. */
@Controller('planning')
export class WorkingDayController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('working-days\\:resolve')
  @Contract('POST /planning/working-days:resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(@Req() request: Request, @Body() body: WorkingDayResolveBody): Promise<WorkingDayResolveResult> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return resolveTargets(this.prisma, body, await scopedPlantIds(this.prisma, session.userId));
  }
}
