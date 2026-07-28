import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { CauseCodeService } from './cause-code.service';
import { DefectCodeService } from './defect-code.service';
import {
  CreateCauseCodeDto,
  CreateDefectCodeDto,
  QualityCodeQueryDto,
  UpdateCauseCodeDto,
  UpdateDefectCodeDto,
} from './quality-code.dto';

@ApiTags('기준정보 — 불량코드')
@Controller('master/defect-codes')
export class DefectCodeController {
  constructor(private readonly service: DefectCodeService) {}

  @RequirePermissions('MASTER_QUALITY_WRITE')
  @Post()
  @ApiOperation({ summary: '불량코드 등록 — 상위를 주면 하위(2계층)가 된다' })
  @ApiResponse({ status: 400, description: '상위가 이미 하위 코드 (3계층 금지)' })
  @ApiResponse({ status: 409, description: '불량코드 중복' })
  create(@Body() dto: CreateDefectCodeDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '불량코드 목록 — 공정·최상위 여부로 좁혀 조회' })
  findAll(@Query() query: QualityCodeQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':defectCode')
  @ApiOperation({ summary: '불량코드 단건 조회 (상위·하위 포함)' })
  @ApiParam({ name: 'defectCode', example: 'SCRATCH' })
  findOne(@Param('defectCode') defectCode: string) {
    return this.service.findOne(defectCode);
  }

  @RequirePermissions('MASTER_QUALITY_WRITE')
  @Patch(':defectCode')
  @ApiOperation({ summary: '불량코드 수정' })
  @ApiResponse({ status: 400, description: '자기 자신을 상위로 지정 · 하위가 있는데 이동' })
  update(
    @Param('defectCode') defectCode: string,
    @Body() dto: UpdateDefectCodeDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(defectCode, dto, actor);
  }

  @RequirePermissions('MASTER_QUALITY_DEACTIVATE')
  @Delete(':defectCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '불량코드 비활성화' })
  @ApiResponse({ status: 409, description: '사용중 하위코드·불량실적이 참조 중' })
  deactivate(@Param('defectCode') defectCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(defectCode, actor);
  }
}

@ApiTags('기준정보 — 원인코드')
@Controller('master/cause-codes')
export class CauseCodeController {
  constructor(private readonly service: CauseCodeService) {}

  @RequirePermissions('MASTER_QUALITY_WRITE')
  @Post()
  @ApiOperation({ summary: '원인코드 등록 — 상위를 주면 하위(2계층)가 된다' })
  @ApiResponse({ status: 400, description: '상위가 이미 하위 코드 (3계층 금지)' })
  @ApiResponse({ status: 409, description: '원인코드 중복' })
  create(@Body() dto: CreateCauseCodeDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '원인코드 목록 — 공정·최상위 여부로 좁혀 조회' })
  findAll(@Query() query: QualityCodeQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':causeCode')
  @ApiOperation({ summary: '원인코드 단건 조회 (상위·하위 포함)' })
  @ApiParam({ name: 'causeCode', example: 'MOLD_WEAR' })
  findOne(@Param('causeCode') causeCode: string) {
    return this.service.findOne(causeCode);
  }

  @RequirePermissions('MASTER_QUALITY_WRITE')
  @Patch(':causeCode')
  @ApiOperation({ summary: '원인코드 수정' })
  @ApiResponse({ status: 400, description: '자기 자신을 상위로 지정 · 하위가 있는데 이동' })
  update(
    @Param('causeCode') causeCode: string,
    @Body() dto: UpdateCauseCodeDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(causeCode, dto, actor);
  }

  @RequirePermissions('MASTER_QUALITY_DEACTIVATE')
  @Delete(':causeCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '원인코드 비활성화' })
  @ApiResponse({ status: 409, description: '사용중 하위코드·추정/확정원인이 참조 중' })
  deactivate(@Param('causeCode') causeCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(causeCode, actor);
  }
}
