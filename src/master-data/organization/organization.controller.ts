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
import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PageQueryDto } from '../../common/dto/page-query.dto';
import {
  CreateBusinessUnitBodyDto,
  CreateLegalEntityDto,
  CreatePlantBodyDto,
  UpdateBusinessUnitDto,
  UpdateLegalEntityDto,
  UpdatePlantDto,
} from './organization.dto';
import { OrganizationService } from './organization.service';

@ApiTags('기준정보 — 조직(법인)')
@Controller('master/legal-entities')
export class LegalEntityController {
  constructor(private readonly service: OrganizationService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '법인 등록' })
  create(@Body() dto: CreateLegalEntityDto, @ActorId() actor?: bigint) {
    return this.service.createLegalEntity(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '법인 목록' })
  findAll(@Query() query: PageQueryDto) {
    return this.service.findLegalEntities(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':legalEntityCode')
  @ApiOperation({ summary: '법인 단건 조회' })
  findOne(@Param('legalEntityCode') code: string) {
    return this.service.findLegalEntity(code);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':legalEntityCode')
  @ApiOperation({ summary: '법인 수정' })
  update(@Param('legalEntityCode') code: string, @Body() dto: UpdateLegalEntityDto, @ActorId() actor?: bigint) {
    return this.service.updateLegalEntity(code, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':legalEntityCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '법인 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 사업부·공장 잔존' })
  deactivate(@Param('legalEntityCode') code: string, @ActorId() actor?: bigint) {
    return this.service.deactivateLegalEntity(code, actor);
  }
}

@ApiTags('기준정보 — 조직(사업부)')
@ApiParam({ name: 'legalEntityCode', description: '소속 법인 코드', example: 'OMF_VN' })
@Controller('master/legal-entities/:legalEntityCode/business-units')
export class BusinessUnitController {
  constructor(private readonly service: OrganizationService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '사업부 등록' })
  create(@Param('legalEntityCode') le: string, @Body() dto: CreateBusinessUnitBodyDto, @ActorId() actor?: bigint) {
    return this.service.createBusinessUnit({ ...dto, legalEntityCode: le }, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '사업부 목록' })
  findAll(@Param('legalEntityCode') le: string, @Query() query: PageQueryDto) {
    return this.service.findBusinessUnits(le, query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':businessUnitCode')
  @ApiOperation({ summary: '사업부 단건 조회' })
  findOne(@Param('legalEntityCode') le: string, @Param('businessUnitCode') code: string) {
    return this.service.findBusinessUnit(le, code);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':businessUnitCode')
  @ApiOperation({ summary: '사업부 수정' })
  update(
    @Param('legalEntityCode') le: string,
    @Param('businessUnitCode') code: string,
    @Body() dto: UpdateBusinessUnitDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.updateBusinessUnit(le, code, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':businessUnitCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '사업부 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 창고 잔존' })
  deactivate(@Param('legalEntityCode') le: string, @Param('businessUnitCode') code: string, @ActorId() actor?: bigint) {
    return this.service.deactivateBusinessUnit(le, code, actor);
  }
}

@ApiTags('기준정보 — 조직(공장)')
@ApiParam({ name: 'legalEntityCode', description: '소속 법인 코드', example: 'OMF_VN' })
@Controller('master/legal-entities/:legalEntityCode/plants')
export class PlantController {
  constructor(private readonly service: OrganizationService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '공장 등록' })
  create(@Param('legalEntityCode') le: string, @Body() dto: CreatePlantBodyDto, @ActorId() actor?: bigint) {
    return this.service.createPlant({ ...dto, legalEntityCode: le }, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '공장 목록' })
  findAll(@Param('legalEntityCode') le: string, @Query() query: PageQueryDto) {
    return this.service.findPlants(le, query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':plantCode')
  @ApiOperation({ summary: '공장 단건 조회' })
  findOne(@Param('legalEntityCode') le: string, @Param('plantCode') code: string) {
    return this.service.findPlant(le, code);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':plantCode')
  @ApiOperation({ summary: '공장 수정' })
  update(
    @Param('legalEntityCode') le: string,
    @Param('plantCode') code: string,
    @Body() dto: UpdatePlantDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.updatePlant(le, code, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':plantCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '공장 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 창고 잔존' })
  deactivate(@Param('legalEntityCode') le: string, @Param('plantCode') code: string, @ActorId() actor?: bigint) {
    return this.service.deactivatePlant(le, code, actor);
  }
}
