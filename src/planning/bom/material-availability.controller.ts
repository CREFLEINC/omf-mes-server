import { Body, Controller, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { PrismaService } from '../../prisma/prisma.service';
import { scopedPlantIds } from '../production-order/production-order-scope';
import { MaterialAvailabilityBody, MaterialAvailabilityLine, materialAvailability } from './material-availability';

/** 생산계획 BOM 단계·제안 검토·배포 확인이 구성 자재의 가용 수량을 묻는다 — 읽기만 한다(omf-all-around#320). */
@Controller('planning')
export class MaterialAvailabilityController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('boms\\:material-availability')
  @Contract('POST /planning/boms:material-availability')
  @HttpCode(HttpStatus.OK)
  async query(@Req() request: Request, @Body() body: MaterialAvailabilityBody): Promise<{ items: MaterialAvailabilityLine[] }> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return materialAvailability(this.prisma, body, await scopedPlantIds(this.prisma, session.userId));
  }
}
