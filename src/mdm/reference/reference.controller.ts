import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { ReferenceQuery } from './reference.query';
import { ReferenceService } from './reference.service';

/**
 * 조회 전용 기준정보 7종. 다른 화면이 선택 목록으로 부른다.
 *
 * 질의 타입은 계약 검증 가드(`#94`)가 이미 강제하고 문자열을 숫자·불리언으로 바꿔 둔다 —
 * 컨트롤러가 다시 파싱하지 않는다.
 */
@Controller('mdm')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get('uoms')
  @Contract('GET /mdm/uoms')
  uoms(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.reference.uoms(query);
  }

  @Get('legal-entities')
  @Contract('GET /mdm/legal-entities')
  legalEntities(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.reference.legalEntities(query);
  }

  @Get('business-units')
  @Contract('GET /mdm/business-units')
  businessUnits(
    @Query() query: ReferenceQuery & { legalEntityId?: number },
  ): Promise<PagedResponse<unknown>> {
    return this.reference.businessUnits(query);
  }

  @Get('plants')
  @Contract('GET /mdm/plants')
  plants(
    @Query() query: ReferenceQuery & { legalEntityId?: number; businessUnitId?: number },
  ): Promise<PagedResponse<unknown>> {
    return this.reference.plants(query);
  }

  @Get('production-lines')
  @Contract('GET /mdm/production-lines')
  productionLines(
    @Query() query: ReferenceQuery & { plantId?: number },
  ): Promise<PagedResponse<unknown>> {
    return this.reference.productionLines(query);
  }

  @Get('processes')
  @Contract('GET /mdm/processes')
  processes(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.reference.processes(query);
  }

  @Get('shifts')
  @Contract('GET /mdm/shifts')
  shifts(@Query() query: ReferenceQuery & { plantId?: number }): Promise<PagedResponse<unknown>> {
    return this.reference.shifts(query);
  }
}
