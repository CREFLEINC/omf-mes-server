import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { ShiftCreate, ShiftService, ShiftUpdate } from './shift.service';

/**
 * 교대 관리(W-06-26 · omf-all-around#318). 목록은 기존 조회 API(`GET /mdm/shifts` · `ReferenceController`)를 그대로 쓴다.
 */
@Controller('mdm/shifts')
export class ShiftController {
  constructor(
    private readonly shifts: ShiftService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':shiftId')
  @Contract('GET /mdm/shifts/{shiftId}')
  async get(
    @Param('shiftId', ParseIntPipe) shiftId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { shift, editability, versionNo } = await this.shifts.get(shiftId);
    setEtag(response, versionNo);
    return { shift, editability };
  }

  @Post()
  @Contract('POST /mdm/shifts')
  create(@Req() request: Request, @Body() body: ShiftCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, (tx) =>
      this.shifts.create(tx, currentSession(request)?.userId, body),
    );
  }

  @Put(':shiftId')
  @Contract('PUT /mdm/shifts/{shiftId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('shiftId', ParseIntPipe) shiftId: number,
    @Body() body: ShiftUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'shift', (version) =>
      this.shifts.update(currentSession(request)?.userId, shiftId, version, body),
    );
  }

  @Post(':shiftId\\:deactivate')
  @Contract('POST /mdm/shifts/{shiftId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('shiftId', ParseIntPipe) shiftId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'shift', (version) =>
      this.shifts.deactivate(currentSession(request)?.userId, shiftId, version),
    );
  }

  @Post(':shiftId\\:activate')
  @Contract('POST /mdm/shifts/{shiftId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('shiftId', ParseIntPipe) shiftId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'shift', (version) =>
      this.shifts.activate(currentSession(request)?.userId, shiftId, version),
    );
  }
}
