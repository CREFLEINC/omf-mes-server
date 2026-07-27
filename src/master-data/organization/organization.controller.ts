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

  @Post()
  @ApiOperation({ summary: '법인 등록' })
  create(@Body() dto: CreateLegalEntityDto) {
    return this.service.createLegalEntity(dto);
  }

  @Get()
  @ApiOperation({ summary: '법인 목록' })
  findAll(@Query() query: PageQueryDto) {
    return this.service.findLegalEntities(query);
  }

  @Get(':legalEntityCode')
  @ApiOperation({ summary: '법인 단건 조회' })
  findOne(@Param('legalEntityCode') code: string) {
    return this.service.findLegalEntity(code);
  }

  @Patch(':legalEntityCode')
  @ApiOperation({ summary: '법인 수정' })
  update(@Param('legalEntityCode') code: string, @Body() dto: UpdateLegalEntityDto) {
    return this.service.updateLegalEntity(code, dto);
  }

  @Delete(':legalEntityCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '법인 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 사업부·공장 잔존' })
  deactivate(@Param('legalEntityCode') code: string) {
    return this.service.deactivateLegalEntity(code);
  }
}

@ApiTags('기준정보 — 조직(사업부)')
@ApiParam({ name: 'legalEntityCode', description: '소속 법인 코드', example: 'OMF_VN' })
@Controller('master/legal-entities/:legalEntityCode/business-units')
export class BusinessUnitController {
  constructor(private readonly service: OrganizationService) {}

  @Post()
  @ApiOperation({ summary: '사업부 등록' })
  create(@Param('legalEntityCode') le: string, @Body() dto: CreateBusinessUnitBodyDto) {
    return this.service.createBusinessUnit({ ...dto, legalEntityCode: le });
  }

  @Get()
  @ApiOperation({ summary: '사업부 목록' })
  findAll(@Param('legalEntityCode') le: string, @Query() query: PageQueryDto) {
    return this.service.findBusinessUnits(le, query);
  }

  @Get(':businessUnitCode')
  @ApiOperation({ summary: '사업부 단건 조회' })
  findOne(@Param('legalEntityCode') le: string, @Param('businessUnitCode') code: string) {
    return this.service.findBusinessUnit(le, code);
  }

  @Patch(':businessUnitCode')
  @ApiOperation({ summary: '사업부 수정' })
  update(
    @Param('legalEntityCode') le: string,
    @Param('businessUnitCode') code: string,
    @Body() dto: UpdateBusinessUnitDto,
  ) {
    return this.service.updateBusinessUnit(le, code, dto);
  }

  @Delete(':businessUnitCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '사업부 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 창고 잔존' })
  deactivate(@Param('legalEntityCode') le: string, @Param('businessUnitCode') code: string) {
    return this.service.deactivateBusinessUnit(le, code);
  }
}

@ApiTags('기준정보 — 조직(공장)')
@ApiParam({ name: 'legalEntityCode', description: '소속 법인 코드', example: 'OMF_VN' })
@Controller('master/legal-entities/:legalEntityCode/plants')
export class PlantController {
  constructor(private readonly service: OrganizationService) {}

  @Post()
  @ApiOperation({ summary: '공장 등록' })
  create(@Param('legalEntityCode') le: string, @Body() dto: CreatePlantBodyDto) {
    return this.service.createPlant({ ...dto, legalEntityCode: le });
  }

  @Get()
  @ApiOperation({ summary: '공장 목록' })
  findAll(@Param('legalEntityCode') le: string, @Query() query: PageQueryDto) {
    return this.service.findPlants(le, query);
  }

  @Get(':plantCode')
  @ApiOperation({ summary: '공장 단건 조회' })
  findOne(@Param('legalEntityCode') le: string, @Param('plantCode') code: string) {
    return this.service.findPlant(le, code);
  }

  @Patch(':plantCode')
  @ApiOperation({ summary: '공장 수정' })
  update(
    @Param('legalEntityCode') le: string,
    @Param('plantCode') code: string,
    @Body() dto: UpdatePlantDto,
  ) {
    return this.service.updatePlant(le, code, dto);
  }

  @Delete(':plantCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '공장 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 창고 잔존' })
  deactivate(@Param('legalEntityCode') le: string, @Param('plantCode') code: string) {
    return this.service.deactivatePlant(le, code);
  }
}
