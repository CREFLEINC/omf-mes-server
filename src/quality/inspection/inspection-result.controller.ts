import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { InspectionResultListQuery, InspectionResultQueryService } from './inspection-result-query.service';
import { InspectionResultView } from './inspection-result-view';

/**
 * 검사 결과 조회 2건(I-19 PR ②b). `POST`·`PUT`(PR ③)·`:confirm`(PR ④)이 이어 붙는다.
 * `summary`·`defect-rate-trend`·`measurement-summary`·`/measurements`(PR ⑤)는 **별도
 * 컨트롤러**다(R-18) — 그래도 `quality.module.ts` 의 `controllers` 배열에서 **이 컨트롤러
 * 보다 먼저** 등록해야 한다. `ParseIntPipe` 가 `'summary'` 를 숫자로 못 읽어 400 을 내는
 * 함정은 컨트롤러를 나눠도 라우트 등록 순서에는 그대로 남는다.
 */
@Controller('quality/inspection-results')
export class InspectionResultController {
  constructor(private readonly results: InspectionResultQueryService) {}

  @Get()
  @Contract('GET /quality/inspection-results')
  list(@Query() query: InspectionResultListQuery): Promise<PagedResponse<InspectionResultView>> {
    return this.results.list(query);
  }

  @Get(':inspectionResultId')
  @Contract('GET /quality/inspection-results/{inspectionResultId}')
  async detail(
    @Param('inspectionResultId', ParseIntPipe) inspectionResultId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InspectionResultView> {
    const { view, versionNo } = await this.results.detail(inspectionResultId);
    setEtag(response, versionNo);
    return view;
  }
}
