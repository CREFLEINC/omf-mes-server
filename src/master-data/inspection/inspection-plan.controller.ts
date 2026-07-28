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
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import {
  CreateInspectionItemSpecDto,
  CreateInspectionPlanDto,
  CreateInspectionPlanVersionDto,
  InspectionPlanQueryDto,
  InspectionPlanVersionQueryDto,
  UpdateInspectionItemSpecDto,
  UpdateInspectionPlanDto,
  UpdateInspectionPlanVersionDto,
} from './inspection-plan.dto';
import { InspectionPlanService } from './inspection-plan.service';

@ApiTags('기준정보 — 검사기준')
@Controller('master/inspection-plans')
export class InspectionPlanController {
  constructor(private readonly service: InspectionPlanService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '검사기준 등록' })
  @ApiResponse({ status: 400, description: '검사유형 코드값 오류' })
  @ApiResponse({ status: 409, description: '검사기준 코드 중복' })
  create(@Body() dto: CreateInspectionPlanDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '검사기준 목록 — 검사유형·품목·공정으로 좁혀 조회' })
  findAll(@Query() query: InspectionPlanQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':planCode')
  @ApiOperation({ summary: '검사기준 단건 조회 (버전 목록 포함)' })
  @ApiParam({ name: 'planCode', example: 'IP_COVER_IQC' })
  findOne(@Param('planCode') planCode: string) {
    return this.service.findOne(planCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':planCode')
  @ApiOperation({ summary: '검사기준 수정' })
  update(
    @Param('planCode') planCode: string,
    @Body() dto: UpdateInspectionPlanDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(planCode, dto, actor);
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':planCode/approval')
  @ApiOperation({ summary: '검사기준 승인 — 승인자는 호출한 사용자로 기록된다' })
  approve(@Param('planCode') planCode: string, @ActorId() actor?: bigint) {
    return this.service.approve(planCode, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':planCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '검사기준 비활성화' })
  @ApiResponse({ status: 409, description: '검사요청이 참조 중' })
  deactivate(@Param('planCode') planCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(planCode, actor);
  }
}

@ApiTags('기준정보 — 검사기준 버전')
@ApiParam({ name: 'planCode', description: '소속 검사기준 코드', example: 'IP_COVER_IQC' })
@Controller('master/inspection-plans/:planCode/versions')
export class InspectionPlanVersionController {
  constructor(private readonly service: InspectionPlanService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '기준 버전 등록 — 샘플링·주기·판정개수' })
  @ApiResponse({
    status: 400,
    description: 'AQL인데 aqlValue 누락 · 주기검사인데 간격 누락 · Re ≤ Ac · 유효기간 역전',
  })
  @ApiResponse({ status: 409, description: '버전 번호 중복' })
  create(
    @Param('planCode') planCode: string,
    @Body() dto: CreateInspectionPlanVersionDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addVersion(planCode, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '기준 버전 목록' })
  findAll(@Param('planCode') planCode: string, @Query() query: InspectionPlanVersionQueryDto) {
    return this.service.findVersions(planCode, query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':planVersion')
  @ApiOperation({ summary: '기준 버전 단건 조회 (검사항목 포함)' })
  @ApiParam({ name: 'planVersion', example: 1 })
  findOne(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
  ) {
    return this.service.findVersion(planCode, planVersion);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':planVersion')
  @ApiOperation({ summary: '기준 버전 수정 — 버전 번호는 바꿀 수 없다' })
  update(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
    @Body() dto: UpdateInspectionPlanVersionDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.updateVersion(planCode, planVersion, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':planVersion')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '기준 버전 삭제 (검사항목을 먼저 비워야 한다)' })
  @ApiResponse({ status: 409, description: '검사요청이 참조 중 · 검사항목 잔존' })
  remove(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
  ) {
    return this.service.removeVersion(planCode, planVersion);
  }
}

@ApiTags('기준정보 — 검사항목')
@ApiParam({ name: 'planCode', description: '소속 검사기준 코드', example: 'IP_COVER_IQC' })
@ApiParam({ name: 'planVersion', description: '소속 기준 버전', example: 1 })
@Controller('master/inspection-plans/:planCode/versions/:planVersion/items')
export class InspectionItemSpecController {
  constructor(private readonly service: InspectionPlanService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '검사항목 등록 — UCL·LCL·Target·측정횟수' })
  @ApiResponse({ status: 400, description: 'UCL < LCL · 계량형 자동판정인데 규격 없음' })
  @ApiResponse({ status: 409, description: '항목 순서 중복' })
  create(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
    @Body() dto: CreateInspectionItemSpecDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addItemSpec(planCode, planVersion, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '검사항목 목록' })
  findAll(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
  ) {
    return this.service.findItemSpecs(planCode, planVersion);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':sequenceNo')
  @ApiOperation({ summary: '검사항목 단건 조회' })
  @ApiParam({ name: 'sequenceNo', example: 10 })
  findOne(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
  ) {
    return this.service.findItemSpec(planCode, planVersion, sequenceNo);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':sequenceNo')
  @ApiOperation({ summary: '검사항목 수정' })
  @ApiResponse({ status: 409, description: '측정 실적이 있어 수정 불가 — 새 버전을 만들어야 한다' })
  update(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
    @Body() dto: UpdateInspectionItemSpecDto,
  ) {
    return this.service.updateItemSpec(planCode, planVersion, sequenceNo, dto);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':sequenceNo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '검사항목 삭제 (수정 이력 컬럼이 없어 물리 삭제)' })
  @ApiResponse({ status: 409, description: '측정 실적이 있어 삭제 불가' })
  remove(
    @Param('planCode') planCode: string,
    @Param('planVersion', ParseIntPipe) planVersion: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
  ) {
    return this.service.removeItemSpec(planCode, planVersion, sequenceNo);
  }
}
