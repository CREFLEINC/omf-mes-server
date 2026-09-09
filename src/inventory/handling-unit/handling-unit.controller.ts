import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { HandlingUnitQuery, HandlingUnitQueryService } from './handling-unit-query.service';
import { HandlingUnitContentView, HandlingUnitDetailView, HandlingUnitView } from './handling-unit-view';
import { HandlingUnitRepackEventView } from './repack-event-view';
import { RepackEventService } from './repack-event.service';
import {
  HandlingUnitContext,
  HandlingUnitCreate,
  HandlingUnitService,
} from './handling-unit.service';

/**
 * 취급 단위 7 오퍼레이션 중 조회 4건(PR ①②) + 등록(PR ③). 구성 치환·포장 확정은 뒤 PR 이
 * 이 컨트롤러에 얹는다(계획 `docs/coverage-100/slices/I-16-a2.md` §11-3 — ①→②→③→④→⑤).
 */
@Controller('inventory/handling-units')
export class HandlingUnitController {
  constructor(
    private readonly queries: HandlingUnitQueryService,
    private readonly repackEvents: RepackEventService,
    private readonly units: HandlingUnitService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /inventory/handling-units')
  list(@Query() query: HandlingUnitQuery): Promise<PagedResponse<HandlingUnitView>> {
    return this.queries.list(query);
  }

  @Get(':handlingUnitId')
  @Contract('GET /inventory/handling-units/{handlingUnitId}')
  async get(
    @Param('handlingUnitId', ParseIntPipe) handlingUnitId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HandlingUnitDetailView> {
    const { handlingUnit, contents, versionNo } = await this.queries.get(handlingUnitId);
    setEtag(response, versionNo);
    return { handlingUnit, contents };
  }

  /** ⛔ 자식 컬렉션 GET 이라 ETag 를 안 붙인다(계약 원문 — 잠그는 단위는 부모다). */
  @Get(':handlingUnitId/contents')
  @Contract('GET /inventory/handling-units/{handlingUnitId}/contents')
  async contents(
    @Param('handlingUnitId', ParseIntPipe) handlingUnitId: number,
  ): Promise<{ items: HandlingUnitContentView[] }> {
    return { items: await this.queries.contents(handlingUnitId) };
  }

  /**
   * 등록. 언제나 `OPEN` 으로 끝난다 — 계약 본문에 상태 칸이 0개다(§4-4).
   * ⭐ 201 에 ETag 를 내리는데, 그 값이 **재전송 응답에도** 실려야 한다 — `runIdempotent`
   * 는 `setEtag` 를 안 부르므로 서비스가 버전을 «캐시되는 본문»에 담아 돌려준다(§4-1).
   * ⛔ If-Match 는 안 받는다 — 새 자원이라 대조할 버전이 없다(C-9).
   */
  @Post()
  @Contract('POST /inventory/handling-units')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: HandlingUnitCreate,
  ): Promise<HandlingUnitDetailView> {
    const { versionNo, view } = await runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.units.create(body, contextOf(request)),
    );
    setEtag(response, versionNo);
    return view;
  }

  /** ⛔ 계약 응답이 `{items[]}` 뿐이라 `page` 가 없다 — 전건을 내린다(§6-4). */
  @Get(':handlingUnitId/repack-events')
  @Contract('GET /inventory/handling-units/{handlingUnitId}/repack-events')
  async repackEventList(
    @Param('handlingUnitId', ParseIntPipe) handlingUnitId: number,
  ): Promise<{ items: HandlingUnitRepackEventView[] }> {
    return { items: await this.repackEvents.list(handlingUnitId) };
  }
}

/** 헤더는 계약 검증 가드가 «안» 본다 — 사번 필수 판정은 서비스 몫이다(이동 도착 선례). */
function contextOf(request: Request): HandlingUnitContext {
  const workerNo = request.header('X-Worker-No');
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return { workerNo: typeof workerNo === 'string' ? workerNo : undefined, appUserId: session.userId };
}
