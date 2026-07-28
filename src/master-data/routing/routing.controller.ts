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
  CreateRoutingDependencyDto,
  CreateRoutingDto,
  CreateRoutingOperationDto,
  RoutingQueryDto,
  UpdateRoutingDto,
  UpdateRoutingOperationDto,
} from './routing.dto';
import { RoutingService } from './routing.service';

@ApiTags('기준정보 — 라우팅')
@Controller('master/routings')
export class RoutingController {
  constructor(private readonly service: RoutingService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '라우팅 Rev 등록' })
  @ApiResponse({ status: 400, description: '상태 코드값 오류 · 유효기간 역전' })
  @ApiResponse({ status: 409, description: '품목×라우팅코드×Rev 중복' })
  create(@Body() dto: CreateRoutingDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '라우팅 목록 — 품목·상태로 좁혀 조회' })
  findAll(@Query() query: RoutingQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':routingId')
  @ApiOperation({ summary: '라우팅 단건 조회 (공정 라인 포함)' })
  @ApiParam({ name: 'routingId', example: 1 })
  findOne(@Param('routingId', ParseIntPipe) routingId: number) {
    return this.service.findOne(BigInt(routingId));
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':routingId')
  @ApiOperation({ summary: '라우팅 수정 — 품목·코드·Rev는 바꿀 수 없다' })
  update(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Body() dto: UpdateRoutingDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(BigInt(routingId), dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':routingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '라우팅 폐기 — status_code=OBSOLETE' })
  @ApiResponse({ status: 409, description: '생산계획·작업지시가 참조 중' })
  obsolete(@Param('routingId', ParseIntPipe) routingId: number, @ActorId() actor?: bigint) {
    return this.service.obsolete(BigInt(routingId), actor);
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':routingId/dependencies')
  @ApiOperation({ summary: '공정 선후행 등록' })
  @ApiResponse({ status: 400, description: '선행=후행 · 선후행 순환' })
  @ApiResponse({ status: 409, description: '동일 선후행 중복' })
  addDependency(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Body() dto: CreateRoutingDependencyDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addDependency(BigInt(routingId), dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':routingId/dependencies')
  @ApiOperation({ summary: '공정 선후행 목록' })
  findDependencies(@Param('routingId', ParseIntPipe) routingId: number) {
    return this.service.findDependencies(BigInt(routingId));
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':routingId/dependencies/:dependencyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '공정 선후행 삭제' })
  removeDependency(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Param('dependencyId', ParseIntPipe) dependencyId: number,
  ) {
    return this.service.removeDependency(BigInt(routingId), BigInt(dependencyId));
  }
}

@ApiTags('기준정보 — 라우팅 공정')
@ApiParam({ name: 'routingId', description: '소속 라우팅 ID', example: 1 })
@Controller('master/routings/:routingId/operations')
export class RoutingOperationController {
  constructor(private readonly service: RoutingService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '공정 라인 등록' })
  @ApiResponse({ status: 409, description: '공정 순서 중복' })
  create(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Body() dto: CreateRoutingOperationDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addOperation(BigInt(routingId), dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '공정 라인 목록' })
  findAll(@Param('routingId', ParseIntPipe) routingId: number) {
    return this.service.findOperations(BigInt(routingId));
  }

  @RequirePermissions('MASTER_READ')
  @Get(':operationSeq')
  @ApiOperation({ summary: '공정 라인 단건 조회' })
  @ApiParam({ name: 'operationSeq', description: '라우팅 내 공정 순서', example: 10 })
  findOne(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Param('operationSeq', ParseIntPipe) operationSeq: number,
  ) {
    return this.service.findOperation(BigInt(routingId), operationSeq);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':operationSeq')
  @ApiOperation({ summary: '공정 라인 수정 — 표준 C/T·수율·관리 플래그' })
  update(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Param('operationSeq', ParseIntPipe) operationSeq: number,
    @Body() dto: UpdateRoutingOperationDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.updateOperation(BigInt(routingId), operationSeq, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':operationSeq')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '공정 라인 삭제 (비활성 플래그가 없어 물리 삭제)' })
  @ApiResponse({ status: 409, description: '작업지시·BOM 라인·선후행이 참조 중' })
  remove(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Param('operationSeq', ParseIntPipe) operationSeq: number,
  ) {
    return this.service.removeOperation(BigInt(routingId), operationSeq);
  }
}
