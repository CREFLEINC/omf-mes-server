import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { resolveTerminalId } from '../../auth/terminal-token';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkSessionEnd, WorkSessionEndService } from './work-session-end.service';
import { WorkSessionEventCreate, WorkSessionEventService } from './work-session-event.service';
import {
  WorkSessionWorkerJoin,
  WorkSessionWorkerLeave,
  WorkSessionWorkerService,
} from './work-session-worker.service';
import {
  WorkSessionListQuery,
  WorkSessionQueryService,
} from './work-session-query.service';
import { WorkSessionCreate, WorkSessionService } from './work-session.service';
import { WorkSessionEventView, WorkSessionView, WorkSessionWorkerView } from './work-session-view';

/**
 * 작업 세션 조회 4건(I-11 PR ①) + 세션 열기·닫기(PR ③) + 사건 적재·작업자 참여·이탈(PR ④).
 * ⛔ `setEtag`·`ifMatchVersion`·`runVersioned` 를 부르지 않는다 — 계약이 조회 5건 어디에도
 *    응답 헤더를 선언하지 않았다(I-11 §8).
 * ⛔ 권한 가드는 계약이 403 을 «선언한» 자리에서만 본다 — 조회는 미선언이라 권한 표를
 *    손대지 않는다(`permission.guard.ts:37-41`).
 */
@Controller('production/work-sessions')
export class WorkSessionController {
  constructor(
    private readonly queries: WorkSessionQueryService,
    private readonly sessions: WorkSessionService,
    private readonly ends: WorkSessionEndService,
    private readonly eventWrites: WorkSessionEventService,
    private readonly workerWrites: WorkSessionWorkerService,
    private readonly idempotency: IdempotencyService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /production/work-sessions')
  list(@Query() query: WorkSessionListQuery): Promise<PagedResponse<WorkSessionView>> {
    return this.queries.list(query);
  }

  @Get(':workSessionId')
  @Contract('GET /production/work-sessions/{workSessionId}')
  detail(@Param('workSessionId', ParseIntPipe) workSessionId: number): Promise<WorkSessionView> {
    return this.queries.detail(workSessionId);
  }

  @Get(':workSessionId/events')
  @Contract('GET /production/work-sessions/{workSessionId}/events')
  events(
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Query() query: { eventTypeCode?: string },
  ): Promise<WorkSessionEventView[]> {
    return this.queries.events(workSessionId, query);
  }

  @Get(':workSessionId/workers')
  @Contract('GET /production/work-sessions/{workSessionId}/workers')
  workers(
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Query() query: { active?: boolean },
  ): Promise<WorkSessionWorkerView[]> {
    return this.queries.workers(workSessionId, query);
  }
  // ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 «선택»이라 토큰이 없으면 저쪽이 던져 500 이
  //    된다(`master-write.ts:48`). ⛔ ETag 를 안 싣는다(계약 미선언).
  @Post()
  @Contract('POST /production/work-sessions')
  async create(@Req() request: Request, @Body() body: WorkSessionCreate): Promise<WorkSessionView> {
    const context = { ...(await this.contextOf(request)), idempotencyKey: String(request.headers['idempotency-key']) };
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.sessions.create(body, context), FAMILY_CONFLICT_CODE);
  }
  /** 세션 닫기. 계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다. */
  @Post(':workSessionId\\:end')
  @Contract('POST /production/work-sessions/{workSessionId}:end')
  @HttpCode(HttpStatus.OK)
  async end(
    @Req() request: Request,
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Body() body: WorkSessionEnd,
  ): Promise<WorkSessionView> {
    const context = await this.contextOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.ends.end(workSessionId, body, context), FAMILY_CONFLICT_CODE);
  }
  /** 세션 구간 «안»의 사건(STOP·RESUME). 201 이라 `@HttpCode` 를 되돌리지 않는다. */
  @Post(':workSessionId/events')
  @Contract('POST /production/work-sessions/{workSessionId}/events')
  async createEvent(
    @Req() request: Request,
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Body() body: WorkSessionEventCreate,
  ): Promise<WorkSessionEventView> {
    const context = await this.contextOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.eventWrites.create(workSessionId, body, context), FAMILY_CONFLICT_CODE);
  }
  // ⛔ 사번을 읽지 않는다 — 계약이 이 둘에만 `X-Worker-No` 를 안 걸었다(R-13 ⓠ). 단말 토큰은
  //    «온 경우만» 검증하려고 푼다 — 값은 담을 칸이 없어 버린다.
  @Post(':workSessionId/workers')
  @Contract('POST /production/work-sessions/{workSessionId}/workers')
  async joinWorker(
    @Req() request: Request,
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Body() body: WorkSessionWorkerJoin,
  ): Promise<WorkSessionWorkerView> {
    const { version, appUserId } = await this.contextOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.workerWrites.join(workSessionId, body, { version, appUserId }), FAMILY_CONFLICT_CODE);
  }
  /** 계약 응답이 200 이다. ⛔ If-Match 를 읽지 않는다 — 계약이 이 자리에만 안 걸었다. */
  @Post(':workSessionId/workers/:workSessionWorkerId\\:leave')
  @Contract('POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave')
  @HttpCode(HttpStatus.OK)
  async leaveWorker(
    @Req() request: Request,
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Param('workSessionWorkerId', ParseIntPipe) workSessionWorkerId: number,
    @Body() body: WorkSessionWorkerLeave,
  ): Promise<WorkSessionWorkerView> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.workerWrites.leave(workSessionId, workSessionWorkerId, body), FAMILY_CONFLICT_CODE);
  }
  // ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:206`) — 사번의 필수 판정은
  //    서비스 몫이고, 단말 토큰은 «없으면 null» 이라 그 뜻도 서비스가 가른다(R-1).
  private async contextOf(request: Request) {
    const workerNo = request.headers['x-worker-no'];
    return {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      version: ifMatchVersion(request),
      appUserId: currentSession(request)?.userId,
      terminalId: await resolveTerminalId(this.jwt, this.prisma, request),
    };
  }
}
