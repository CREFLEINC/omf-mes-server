import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { InspectionMeasurementService, MeasurementListQuery, MeasurementView } from './inspection-measurement.service';
import { DefectRateTrendQuery, InspectionSummaryQuery, InspectionSummaryService } from './inspection-summary.service';

/**
 * 집계 3 + 측정치 목록(I-19 PR ⑤). ⭐ **별도 컨트롤러다**(R-18) — `summary`·`defect-rate-trend`
 * 같은 «고정 낱말» 경로를 `:inspectionResultId` 를 가진 컨트롤러와 한 파일에 두면 `ParseIntPipe`
 * 가 `'summary'` 를 숫자로 못 읽어 400 을 낸다. 여기로 떼면 그 함정이 **구조적으로** 사라진다.
 * ⚠ 다만 `quality.module.ts` 의 `controllers` 에서 **`InspectionResultController` 보다 먼저**
 *   등록해야 한다 — 라우트는 등록 순서로 잡힌다.
 * ⛔ 조회 4건이라 멱등·If-Match 가 없고, ETag 도 안 낸다 — 계약이 이 넷 어디에도 선언하지
 *   않았다(자식 컬렉션 GET 은 B-1-1 이 붙이지 말라고 적었다).
 * ⛔ 403 을 선언한 자리가 0 이라 권한 등록도 0 이다(`manual-permissions.ts` 0줄).
 */
@Controller('quality/inspection-results')
export class InspectionSummaryController {
  constructor(
    private readonly summaries: InspectionSummaryService,
    private readonly measurements: InspectionMeasurementService,
  ) {}

  @Get('summary')
  @Contract('GET /quality/inspection-results/summary')
  summary(@Query() query: InspectionSummaryQuery) {
    return this.summaries.summary(query);
  }

  @Get('defect-rate-trend')
  @Contract('GET /quality/inspection-results/defect-rate-trend')
  trend(@Query() query: DefectRateTrendQuery) {
    return this.summaries.trend(query);
  }

  @Get(':inspectionResultId/measurement-summary')
  @Contract('GET /quality/inspection-results/{inspectionResultId}/measurement-summary')
  measurementSummary(@Param('inspectionResultId', ParseIntPipe) inspectionResultId: number) {
    return this.measurements.itemSummary(inspectionResultId);
  }

  @Get(':inspectionResultId/measurements')
  @Contract('GET /quality/inspection-results/{inspectionResultId}/measurements')
  measurementList(
    @Param('inspectionResultId', ParseIntPipe) inspectionResultId: number,
    @Query() query: MeasurementListQuery,
  ): Promise<PagedResponse<MeasurementView>> {
    return this.measurements.list(inspectionResultId, query);
  }
}
