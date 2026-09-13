import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { resolveTerminalId } from '../../auth/terminal-token';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import type { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RepairExecutionReturn,
  RepairExecutionReturnService,
} from './repair-execution-return.service';
import {
  RepairExecutionListQuery,
  RepairExecutionQueryService,
} from './repair-execution-query.service';
import { RepairExecutionView } from './repair-execution-view';
import { RepairExecutionCreate, RepairExecutionService } from './repair-execution.service';
import { mobileProductionWriteActorOf } from '../mobile-production-write-actor';

/**
 * 수리 실행 목록 조회 1건(I-25 PR ①) + 투입·반출 등록 2건(PR ③).
 * ⛔ 계약이 403 을 선언한 것은 **투입 하나뿐**이고 그 권한(`M-02-02`)은
 *    `derived-permissions.ts:235` 에 **이미 있다** — 권한 표를 손대지 않는다(§6-3).
 * ⛔ 셋 다 계약이 ETag·If-Match 를 선언하지 않았다 — `setEtag`·`runVersioned` 를 부르지 않는다.
 */
@Controller('production/repair-executions')
export class RepairExecutionController {
  constructor(
    private readonly queries: RepairExecutionQueryService,
    private readonly repairs: RepairExecutionService,
    private readonly returns: RepairExecutionReturnService,
    private readonly idempotency: IdempotencyService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /production/repair-executions')
  list(@Req() request: Request, @Query() query: RepairExecutionListQuery): Promise<PagedResponse<RepairExecutionView>> {
    return this.queries.list(query, currentTerminalQualityReadScope(request)?.plantId);
  }

  /** 투입 등록 — 구간을 연다. 단말은 계약이 ⌜서버가 푼다⌝ 라 적어 여기서 토큰을 푼다(§5 ④). */
  @Post()
  @Contract('POST /production/repair-executions')
  async create(
    @Req() request: Request,
    @Body() body: RepairExecutionCreate,
  ): Promise<RepairExecutionView> {
    const actor = mobileProductionWriteActorOf(request, 'POST /production/repair-executions');
    const context = {
      workerNo: workerNoOf(request),
      appUserId: actor.appUserId,
      terminalAudit: actor.terminalAudit,
      // 헤더가 없으면 `null` 이다 — 던지지 않는다(`terminal-token.ts:28`). 「없음」은 여기서
      // 거부 사유가 아니다(세션 열기와 달리 계약이 `can_*` 게이팅을 안 적었다).
      terminalId: currentTerminal(request)?.terminalId ?? await resolveTerminalId(this.jwt, this.prisma, request),
    };
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.repairs.create(body, context),
      FAMILY_CONFLICT_CODE,
    );
  }

  /**
   * 반출 등록 — 구간을 닫는다. 계약 응답이 **200 하나**라 Nest `@Post` 의 기본값 201 을
   * 되돌린다(`work-session.controller.ts:84` 선례). ⛔ 단말을 풀지 않는다 — 담을 칸도
   * 게이팅도 없다(§6-1).
   */
  @Post(':repairExecutionId\\:return')
  @Contract('POST /production/repair-executions/{repairExecutionId}:return')
  @HttpCode(HttpStatus.OK)
  close(
    @Req() request: Request,
    @Param('repairExecutionId', ParseIntPipe) repairExecutionId: number,
    @Body() body: RepairExecutionReturn,
  ): Promise<RepairExecutionView> {
    const actor = mobileProductionWriteActorOf(request, 'POST /production/repair-executions/{repairExecutionId}:return');
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.returns.close(repairExecutionId, body, workerNoOf(request), actor),
      FAMILY_CONFLICT_CODE,
    );
  }
}

/** ⛔ 헤더는 계약 검증 가드가 안 본다 — 사번의 필수 판정은 서비스 몫이다(`assertWorkerNoExists`). */
function workerNoOf(request: Request): string | undefined {
  const workerNo = request.headers['x-worker-no'];
  return typeof workerNo === 'string' ? workerNo : undefined;
}
