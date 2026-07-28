import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  CreateCalibrationDto,
  CreateEquipmentDto,
  CreateProductionLineDto,
  EquipmentQueryDto,
  ProductionLineQueryDto,
  UpdateEquipmentDto,
  UpdateProductionLineDto,
} from './equipment.dto';
import { EquipmentService } from './equipment.service';
import { ProductionLineService } from './production-line.service';

@ApiTags('기준정보 — 생산라인')
@Controller('master/production-lines')
export class ProductionLineController {
  constructor(private readonly service: ProductionLineService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '생산라인·작업구역 등록' })
  @ApiResponse({ status: 400, description: '라인 유형 코드값 오류 · 상위 순환' })
  @ApiResponse({ status: 409, description: '라인 코드 중복' })
  create(@Body() dto: CreateProductionLineDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '생산라인 목록' })
  findAll(@Query() query: ProductionLineQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':lineCode')
  @ApiOperation({ summary: '생산라인 단건 조회' })
  @ApiParam({ name: 'lineCode', example: 'LINE_A' })
  @ApiResponse({ status: 409, description: '라인코드가 여러 공장에 존재 — 공장 지정 필요' })
  findOne(@Param('lineCode') lineCode: string) {
    return this.service.findOne(lineCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':lineCode')
  @ApiOperation({ summary: '생산라인 수정' })
  update(@Param('lineCode') lineCode: string, @Body() dto: UpdateProductionLineDto, @ActorId() actor?: bigint) {
    return this.service.update(lineCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':lineCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '생산라인 비활성화' })
  @ApiResponse({ status: 409, description: '하위 라인·설비가 참조 중' })
  deactivate(@Param('lineCode') lineCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(lineCode, actor);
  }
}

@ApiTags('기준정보 — 설비')
@Controller('master/equipments')
export class EquipmentController {
  constructor(private readonly service: EquipmentService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '설비 등록' })
  @ApiResponse({ status: 400, description: '코드값 오류 · 교정일 역전' })
  @ApiResponse({ status: 409, description: '설비 코드 중복' })
  create(@Body() dto: CreateEquipmentDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({
    summary: '설비 목록 — 공장·유형·상태로 좁히거나 교정 만료 임박분만 조회',
  })
  findAll(@Query() query: EquipmentQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':equipmentCode')
  @ApiOperation({ summary: '설비 단건 조회 (담당 공정·소속 라인 포함)' })
  @ApiParam({ name: 'equipmentCode', example: 'EQ_INJ_01' })
  @ApiResponse({ status: 409, description: '설비코드가 여러 공장에 존재 — 공장 지정 필요' })
  findOne(@Param('equipmentCode') equipmentCode: string) {
    return this.service.findOne(equipmentCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':equipmentCode')
  @ApiOperation({ summary: '설비 수정' })
  update(@Param('equipmentCode') equipmentCode: string, @Body() dto: UpdateEquipmentDto, @ActorId() actor?: bigint) {
    return this.service.update(equipmentCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':equipmentCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '설비 비활성화' })
  @ApiResponse({ status: 409, description: '검사항목 기준이 기본 검사장비로 참조 중' })
  deactivate(@Param('equipmentCode') equipmentCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(equipmentCode, actor);
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':equipmentCode/calibrations')
  @ApiOperation({ summary: '검교정 이력 등록 — 검교정자는 호출한 사용자로 기록된다' })
  @ApiResponse({ status: 400, description: '결과 코드값 오류 · 유효기한이 검교정일보다 빠름' })
  @ApiResponse({ status: 409, description: '같은 날짜의 검교정 기록 중복' })
  addCalibration(
    @Param('equipmentCode') equipmentCode: string,
    @Body() dto: CreateCalibrationDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addCalibration(equipmentCode, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':equipmentCode/calibrations')
  @ApiOperation({ summary: '검교정 이력 목록 — 최근순' })
  findCalibrations(@Param('equipmentCode') equipmentCode: string) {
    return this.service.findCalibrations(equipmentCode);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':equipmentCode/calibrations/:calibrationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '검교정 기록 삭제 (이력 테이블이라 물리 삭제)' })
  removeCalibration(
    @Param('equipmentCode') equipmentCode: string,
    @Param('calibrationId', ParseIntPipe) calibrationId: number,
  ) {
    return this.service.removeCalibration(equipmentCode, BigInt(calibrationId));
  }
}
