import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master-write';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ReferenceQuery } from '../reference/reference.query';
import { ApplicationQuery, DayInput, WorkCalendarService } from './work-calendar.service';

/** 작업 캘린더. 화면은 `W-05-09` 다. */
@Controller('mdm/work-calendars')
export class WorkCalendarController {
  constructor(
    private readonly calendars: WorkCalendarService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/work-calendars')
  list(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.calendars.list(query);
  }

  @Get(':workCalendarId')
  @Contract('GET /mdm/work-calendars/{workCalendarId}')
  async get(
    @Param('workCalendarId', ParseIntPipe) workCalendarId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { workCalendar, editability, applicationCount, versionNo } =
      await this.calendars.get(workCalendarId);
    setEtag(response, versionNo);
    return { workCalendar, editability, applicationCount };
  }

  @Post()
  @Contract('POST /mdm/work-calendars')
  create(
    @Req() request: Request,
    @Body() body: { calendarCode: string; calendarName: string },
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.calendars.create(body),
    );
  }

  @Put(':workCalendarId')
  @Contract('PUT /mdm/work-calendars/{workCalendarId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('workCalendarId', ParseIntPipe) workCalendarId: number,
    @Body() body: { calendarCode?: string; calendarName: string },
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'workCalendar', (version) =>
      this.calendars.update(workCalendarId, version, body),
    );
  }

  @Post(':workCalendarId\\:deactivate')
  @Contract('POST /mdm/work-calendars/{workCalendarId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('workCalendarId', ParseIntPipe) workCalendarId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'workCalendar', (version) =>
      this.calendars.deactivate(workCalendarId, version),
    );
  }

  @Get(':workCalendarId/days')
  @Contract('GET /mdm/work-calendars/{workCalendarId}/days')
  async listDays(
    @Param('workCalendarId', ParseIntPipe) workCalendarId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<unknown> {
    return { items: await this.calendars.listDays(workCalendarId, from, to) };
  }

  /** ⛔ `If-Match` 가 없다 — 계약이 요구하지 않았다. 보낸 날짜만 덮어쓰므로 통째 교체가 아니다. */
  @Put(':workCalendarId/days')
  @Contract('PUT /mdm/work-calendars/{workCalendarId}/days')
  replaceDays(
    @Req() request: Request,
    @Param('workCalendarId', ParseIntPipe) workCalendarId: number,
    @Body() body: { days: DayInput[] },
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      appliedCount: await this.calendars.replaceDays(
        workCalendarId,
        body.days,
        currentSession(request)?.userId,
      ),
    }));
  }
}

/** 캘린더 적용. 같은 화면(`W-05-09`)의 「적용 대상」 구획이다. */
@Controller('mdm/work-calendar-applications')
export class WorkCalendarApplicationController {
  constructor(
    private readonly calendars: WorkCalendarService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/work-calendar-applications')
  list(@Query() query: ApplicationQuery): Promise<PagedResponse<unknown>> {
    return this.calendars.listApplications(query);
  }

  @Get('effective')
  @Contract('GET /mdm/work-calendar-applications/effective')
  effective(@Query('equipmentId', ParseIntPipe) equipmentId: number): Promise<unknown> {
    return this.calendars.effective(equipmentId);
  }

  /**
   * 지정하면 200 + 본체, 비워 보내면 **204**(해제됨) — 계약이 그렇게 갈랐다.
   * 그래서 응답 상태가 본문에 따라 달라지고, 핸들러가 직접 쓴다.
   */
  @Put()
  @Contract('PUT /mdm/work-calendar-applications')
  async apply(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { targetTypeCode: string; targetId: number; workCalendarId?: number | null },
  ): Promise<unknown> {
    const applied = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.calendars.applyCalendar(
        body.targetTypeCode,
        body.targetId,
        body.workCalendarId ?? null,
        currentSession(request)?.userId,
      ),
    );
    if (applied === null) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return applied;
  }
}
