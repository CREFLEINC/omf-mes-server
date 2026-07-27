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
  CreateLocationDto,
  CreateWarehouseDto,
  UpdateLocationDto,
  UpdateWarehouseDto,
  WarehouseQueryDto,
} from './warehouse.dto';
import { WarehouseService } from './warehouse.service';

@ApiTags('기준정보 — 창고')
@Controller('master/warehouses')
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @Post()
  @ApiOperation({ summary: '창고 등록' })
  @ApiResponse({ status: 400, description: '코드값 오류 · 외부창고인데 거래처 미지정' })
  @ApiResponse({ status: 409, description: '창고 코드 중복' })
  create(@Body() dto: CreateWarehouseDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '창고 목록' })
  findAll(@Query() query: WarehouseQueryDto) {
    return this.service.findAll(query, query.plantCode);
  }

  @Get(':warehouseCode')
  @ApiOperation({ summary: '창고 단건 조회' })
  @ApiResponse({ status: 409, description: '창고코드가 여러 공장에 존재 — 공장 지정 필요' })
  findOne(@Param('warehouseCode') code: string) {
    return this.service.findOne(code);
  }

  @Patch(':warehouseCode')
  @ApiOperation({ summary: '창고 수정' })
  update(@Param('warehouseCode') code: string, @Body() dto: UpdateWarehouseDto) {
    return this.service.update(code, dto);
  }

  @Delete(':warehouseCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '창고 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 로케이션 잔존' })
  deactivate(@Param('warehouseCode') code: string) {
    return this.service.deactivate(code);
  }
}

@ApiTags('기준정보 — 로케이션')
@ApiParam({ name: 'warehouseCode', description: '소속 창고 코드', example: 'WH_MAT' })
@Controller('master/warehouses/:warehouseCode/locations')
export class LocationController {
  constructor(private readonly service: WarehouseService) {}

  @Post()
  @ApiOperation({ summary: '로케이션 등록' })
  @ApiResponse({ status: 400, description: '코드값 오류 · 수용량/단위 불일치 · 상위 순환' })
  create(@Param('warehouseCode') wh: string, @Body() dto: CreateLocationDto) {
    return this.service.createLocation(wh, dto);
  }

  @Get()
  @ApiOperation({ summary: '로케이션 목록' })
  findAll(@Param('warehouseCode') wh: string, @Query() query: PageQueryDto) {
    return this.service.findLocations(wh, query);
  }

  @Get(':locationCode')
  @ApiOperation({ summary: '로케이션 단건 조회' })
  findOne(@Param('warehouseCode') wh: string, @Param('locationCode') code: string) {
    return this.service.findLocation(wh, code);
  }

  @Patch(':locationCode')
  @ApiOperation({ summary: '로케이션 수정' })
  update(
    @Param('warehouseCode') wh: string,
    @Param('locationCode') code: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.service.updateLocation(wh, code, dto);
  }

  @Delete(':locationCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '로케이션 비활성화' })
  @ApiResponse({ status: 409, description: '사용중인 하위 로케이션 잔존' })
  deactivate(@Param('warehouseCode') wh: string, @Param('locationCode') code: string) {
    return this.service.deactivateLocation(wh, code);
  }
}
