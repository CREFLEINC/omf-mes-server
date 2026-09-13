import { Controller, Get, Param, ParseIntPipe, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { PagedResponse } from '../../common/pagination';
import { InspectionRequestListQuery, InspectionRequestService } from './inspection-request.service';
import { InspectionRequestView } from './inspection-request-view';

/** 검사 의뢰 조회 2건(I-19 PR ②). 등록 경로는 두지 않는다 — 서버가 입고·실적에서 만든다(계약). */
@Controller('quality/inspection-requests')
export class InspectionRequestController {
  constructor(private readonly requests: InspectionRequestService) {}

  @Get()
  @Contract('GET /quality/inspection-requests')
  list(@Req() request: Request, @Query() query: InspectionRequestListQuery): Promise<PagedResponse<InspectionRequestView>> {
    return this.requests.list(query, currentTerminalQualityReadScope(request));
  }

  /** ⛔ ETag 를 안 낸다(계약 미선언). */
  @Get(':inspectionRequestId')
  @Contract('GET /quality/inspection-requests/{inspectionRequestId}')
  detail(@Req() request: Request, @Param('inspectionRequestId', ParseIntPipe) inspectionRequestId: number): Promise<InspectionRequestView> {
    return this.requests.detail(inspectionRequestId, currentTerminalQualityReadScope(request));
  }
}
