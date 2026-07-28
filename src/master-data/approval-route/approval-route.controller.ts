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
  ApprovalRouteQueryDto,
  CreateApprovalRouteDto,
  CreateApprovalRouteStepDto,
  UpdateApprovalRouteDto,
} from './approval-route.dto';
import { ApprovalRouteService } from './approval-route.service';

@ApiTags('기준정보 — 결재선')
@Controller('master/approval-routes')
export class ApprovalRouteController {
  constructor(private readonly service: ApprovalRouteService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({
    summary: '결재선 등록',
    description: '같은 승인유형에 금액구간을 나눠 여러 라우트를 둘 수 있다(소액=팀장, 고액=임원).',
  })
  @ApiResponse({ status: 400, description: '승인유형 코드값 오류 · 금액구간 역전' })
  create(@Body() dto: CreateApprovalRouteDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '결재선 목록 — 승인유형으로 좁혀 조회 (단계 포함)' })
  findAll(@Query() query: ApprovalRouteQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':routeId')
  @ApiOperation({ summary: '결재선 단건 조회 (단계별 승인자 포함)' })
  @ApiParam({ name: 'routeId', example: 1 })
  findOne(@Param('routeId', ParseIntPipe) routeId: number) {
    return this.service.findOne(BigInt(routeId));
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':routeId')
  @ApiOperation({ summary: '결재선 수정 — 승인유형은 바꿀 수 없다' })
  update(
    @Param('routeId', ParseIntPipe) routeId: number,
    @Body() dto: UpdateApprovalRouteDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(BigInt(routeId), dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':routeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '결재선 비활성화' })
  deactivate(@Param('routeId', ParseIntPipe) routeId: number, @ActorId() actor?: bigint) {
    return this.service.deactivate(BigInt(routeId), actor);
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':routeId/steps')
  @ApiOperation({
    summary: '결재 단계 추가',
    description: '승인자는 사용자·역할·부서 중 정확히 하나로 지정한다.',
  })
  @ApiResponse({ status: 400, description: '승인자 대상이 0개 또는 2개 이상 · 방식과 필드 불일치' })
  @ApiResponse({ status: 409, description: '결재 순서 중복' })
  addStep(
    @Param('routeId', ParseIntPipe) routeId: number,
    @Body() dto: CreateApprovalRouteStepDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addStep(BigInt(routeId), dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':routeId/steps')
  @ApiOperation({ summary: '결재 단계 목록' })
  findSteps(@Param('routeId', ParseIntPipe) routeId: number) {
    return this.service.findSteps(BigInt(routeId));
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':routeId/steps/:stepNo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '결재 단계 삭제 (수정 이력 컬럼이 없어 물리 삭제)' })
  removeStep(
    @Param('routeId', ParseIntPipe) routeId: number,
    @Param('stepNo', ParseIntPipe) stepNo: number,
  ) {
    return this.service.removeStep(BigInt(routeId), stepNo);
  }
}
