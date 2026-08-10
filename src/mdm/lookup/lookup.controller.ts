import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../auth/auth.decorators';
import {
  BusinessUnitQueryDto,
  EquipmentQueryDto,
  LookupQueryDto,
  PlantQueryDto,
  ProductionLineQueryDto,
} from './lookup.query.dto';
import { LookupService } from './lookup.service';

/**
 * 조회 전용 8종. 계약에 쓰기가 없다 — 화면이 드롭다운을 채우거나 필터를 거는 데 쓴다.
 *
 * 상세(`/{id}`)도 계약에 없다. 목록에서 고른 값을 그대로 쓰므로 다시 열 일이 없고,
 * 편집 경로가 없어 `editability` 도 `ETag` 도 필요하지 않다.
 */
@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm')
export class LookupController {
  constructor(private readonly service: LookupService) {}

  @Get('uoms')
  @ApiOperation({ summary: '단위(UOM) 목록' })
  findUoms(@Query() query: LookupQueryDto) {
    return this.service.findUoms(query);
  }

  @Get('partners')
  @ApiOperation({ summary: '거래처 목록' })
  findPartners(@Query() query: LookupQueryDto) {
    return this.service.findPartners(query);
  }

  @Get('legal-entities')
  @ApiOperation({ summary: '법인 목록' })
  findLegalEntities(@Query() query: LookupQueryDto) {
    return this.service.findLegalEntities(query);
  }

  @Get('business-units')
  @ApiOperation({ summary: '사업부 목록' })
  findBusinessUnits(@Query() query: BusinessUnitQueryDto) {
    return this.service.findBusinessUnits(query);
  }

  @Get('plants')
  @ApiOperation({ summary: '공장 목록' })
  findPlants(@Query() query: PlantQueryDto) {
    return this.service.findPlants(query);
  }

  @Get('production-lines')
  @ApiOperation({ summary: '생산라인 목록' })
  findProductionLines(@Query() query: ProductionLineQueryDto) {
    return this.service.findProductionLines(query);
  }

  @Get('processes')
  @ApiOperation({ summary: '공정 목록' })
  findProcesses(@Query() query: LookupQueryDto) {
    return this.service.findProcesses(query);
  }

  @Get('equipments')
  @ApiOperation({ summary: '설비 목록' })
  findEquipments(@Query() query: EquipmentQueryDto) {
    return this.service.findEquipments(query);
  }
}
