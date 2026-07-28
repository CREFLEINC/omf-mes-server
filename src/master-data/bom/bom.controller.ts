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
  BomQueryDto,
  CreateBomComponentDto,
  CreateBomDto,
  CreateSubstitutionRuleDto,
  UpdateBomComponentDto,
  UpdateBomDto,
} from './bom.dto';
import { BomService } from './bom.service';

@ApiTags('기준정보 — BOM')
@Controller('master/boms')
export class BomController {
  constructor(private readonly service: BomService) {}

  @RequirePermissions('MASTER_PRODUCTION_WRITE')
  @Post()
  @ApiOperation({ summary: 'BOM Rev 등록' })
  @ApiResponse({ status: 400, description: '상태 코드값 오류 · 유효기간 역전' })
  @ApiResponse({ status: 409, description: '부모품목×BOM코드×Rev 중복' })
  create(@Body() dto: CreateBomDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: 'BOM 목록 — 부모품목·상태·기본여부로 좁혀 조회' })
  findAll(@Query() query: BomQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':bomId')
  @ApiOperation({ summary: 'BOM 단건 조회 (구성 라인 포함)' })
  @ApiParam({ name: 'bomId', example: 1 })
  findOne(@Param('bomId', ParseIntPipe) bomId: number) {
    return this.service.findOne(BigInt(bomId));
  }

  @RequirePermissions('MASTER_PRODUCTION_WRITE')
  @Patch(':bomId')
  @ApiOperation({ summary: 'BOM 수정 — 부모품목·코드·Rev는 바꿀 수 없다' })
  update(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Body() dto: UpdateBomDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(BigInt(bomId), dto, actor);
  }

  @RequirePermissions('MASTER_PRODUCTION_DEACTIVATE')
  @Delete(':bomId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'BOM 폐기 — status_code=OBSOLETE, 기본 BOM 지정도 해제' })
  @ApiResponse({ status: 409, description: '생산계획이 참조 중' })
  obsolete(@Param('bomId', ParseIntPipe) bomId: number, @ActorId() actor?: bigint) {
    return this.service.obsolete(BigInt(bomId), actor);
  }
}

@ApiTags('기준정보 — BOM 구성')
@ApiParam({ name: 'bomId', description: '소속 BOM ID', example: 1 })
@Controller('master/boms/:bomId/components')
export class BomComponentController {
  constructor(private readonly service: BomService) {}

  @RequirePermissions('MASTER_PRODUCTION_WRITE')
  @Post()
  @ApiOperation({ summary: 'BOM 구성 라인 등록' })
  @ApiResponse({ status: 400, description: '부모=구성 품목 · 타 품목 라우팅 공정 지정' })
  @ApiResponse({ status: 409, description: '라인 순서 중복' })
  create(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Body() dto: CreateBomComponentDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addComponent(BigInt(bomId), dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: 'BOM 구성 라인 목록' })
  findAll(@Param('bomId', ParseIntPipe) bomId: number) {
    return this.service.findComponents(BigInt(bomId));
  }

  @RequirePermissions('MASTER_READ')
  @Get(':sequenceNo')
  @ApiOperation({ summary: 'BOM 구성 라인 단건 조회 (대체규칙 포함)' })
  @ApiParam({ name: 'sequenceNo', description: 'BOM 내 라인 순서', example: 10 })
  findOne(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
  ) {
    return this.service.findComponent(BigInt(bomId), sequenceNo);
  }

  @RequirePermissions('MASTER_PRODUCTION_WRITE')
  @Patch(':sequenceNo')
  @ApiOperation({ summary: 'BOM 구성 라인 수정 — 소요량·손실률·추적 플래그' })
  update(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
    @Body() dto: UpdateBomComponentDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.updateComponent(BigInt(bomId), sequenceNo, dto, actor);
  }

  @RequirePermissions('MASTER_PRODUCTION_DEACTIVATE')
  @Delete(':sequenceNo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'BOM 구성 라인 삭제 (비활성 플래그가 없어 물리 삭제)' })
  @ApiResponse({ status: 409, description: '불출요청·자재소비·대체규칙이 참조 중' })
  remove(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
  ) {
    return this.service.removeComponent(BigInt(bomId), sequenceNo);
  }

  @RequirePermissions('MASTER_PRODUCTION_WRITE')
  @Post(':sequenceNo/substitutions')
  @ApiOperation({ summary: '대체자재 규칙 등록' })
  @ApiResponse({ status: 400, description: '대체=원래 품목 · 유효기간 역전' })
  @ApiResponse({ status: 409, description: '같은 시작일의 대체규칙 중복' })
  addSubstitution(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
    @Body() dto: CreateSubstitutionRuleDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.addSubstitutionRule(BigInt(bomId), sequenceNo, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':sequenceNo/substitutions')
  @ApiOperation({ summary: '대체자재 규칙 목록 — 우선순위 순' })
  findSubstitutions(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
  ) {
    return this.service.findSubstitutionRules(BigInt(bomId), sequenceNo);
  }

  @RequirePermissions('MASTER_PRODUCTION_DEACTIVATE')
  @Delete(':sequenceNo/substitutions/:ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '대체자재 규칙 삭제 (수정 이력 컬럼이 없어 물리 삭제)' })
  removeSubstitution(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('sequenceNo', ParseIntPipe) sequenceNo: number,
    @Param('ruleId', ParseIntPipe) ruleId: number,
  ) {
    return this.service.removeSubstitutionRule(BigInt(bomId), sequenceNo, BigInt(ruleId));
  }
}
