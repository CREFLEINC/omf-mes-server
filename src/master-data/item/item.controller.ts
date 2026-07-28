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
  CreateBuItemMapDto,
  CreateExternalCodeDto,
  CreateItemDto,
  CreateUomConversionDto,
  ItemQueryDto,
  UpdateItemDto,
} from './item.dto';
import { ItemService } from './item.service';

@ApiTags('기준정보 — 품목')
@Controller('master/items')
export class ItemController {
  constructor(private readonly service: ItemService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '품목 등록' })
  @ApiResponse({ status: 400, description: '코드값 오류 · FEFO인데 유효기간 미지정' })
  @ApiResponse({ status: 409, description: '품목코드 중복' })
  create(@Body() dto: CreateItemDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '품목 목록' })
  findAll(@Query() query: ItemQueryDto) {
    return this.service.findAll(query, query.itemTypeCode);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':itemCode')
  @ApiOperation({ summary: '품목 단건 조회 (기본단위·단위환산·외부코드 포함)' })
  @ApiParam({ name: 'itemCode', example: 'ITEM_0001' })
  findOne(@Param('itemCode') itemCode: string) {
    return this.service.findOne(itemCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':itemCode')
  @ApiOperation({ summary: '품목 수정' })
  update(@Param('itemCode') itemCode: string, @Body() dto: UpdateItemDto, @ActorId() actor?: bigint) {
    return this.service.update(itemCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':itemCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '품목 비활성화' })
  @ApiResponse({ status: 409, description: '잔량 재고 보유' })
  deactivate(@Param('itemCode') itemCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(itemCode, actor);
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':itemCode/uom-conversions')
  @ApiOperation({ summary: '단위환산 추가' })
  @ApiResponse({ status: 400, description: '동일 단위 · 유효기간 역전' })
  addConversion(@Param('itemCode') itemCode: string, @Body() dto: CreateUomConversionDto, @ActorId() actor?: bigint) {
    return this.service.addUomConversion(itemCode, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':itemCode/uom-conversions')
  @ApiOperation({ summary: '단위환산 목록' })
  findConversions(@Param('itemCode') itemCode: string) {
    return this.service.findUomConversions(itemCode);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':itemCode/uom-conversions/:conversionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '단위환산 삭제 (이력 테이블이라 물리 삭제)' })
  removeConversion(
    @Param('itemCode') itemCode: string,
    @Param('conversionId', ParseIntPipe) conversionId: number
  ) {
    return this.service.removeUomConversion(itemCode, BigInt(conversionId));
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':itemCode/external-codes')
  @ApiOperation({ summary: '외부 시스템 품목코드 추가' })
  @ApiResponse({ status: 409, description: '동일 (시스템·거래처·코드) 중복' })
  addExternalCode(@Param('itemCode') itemCode: string, @Body() dto: CreateExternalCodeDto, @ActorId() actor?: bigint) {
    return this.service.addExternalCode(itemCode, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':itemCode/external-codes')
  @ApiOperation({ summary: '외부 시스템 품목코드 목록' })
  findExternalCodes(@Param('itemCode') itemCode: string) {
    return this.service.findExternalCodes(itemCode);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':itemCode/external-codes/:externalCodeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '외부 시스템 품목코드 삭제' })
  removeExternalCode(
    @Param('itemCode') itemCode: string,
    @Param('externalCodeId', ParseIntPipe) externalCodeId: number
  ) {
    return this.service.removeExternalCode(itemCode, BigInt(externalCodeId));
  }

  @RequirePermissions('MASTER_WRITE')
  @Post(':itemCode/bu-mappings')
  @ApiOperation({ summary: '사업부 간 품목 매핑 추가 — 매핑이 없으면 사업부 간 이동입고가 막힌다' })
  @ApiResponse({ status: 400, description: '동일 사업부 · 유효기간 역전' })
  addBuMapping(@Param('itemCode') itemCode: string, @Body() dto: CreateBuItemMapDto, @ActorId() actor?: bigint) {
    return this.service.addBuItemMap(itemCode, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':itemCode/bu-mappings')
  @ApiOperation({ summary: '사업부 간 품목 매핑 목록' })
  findBuMappings(@Param('itemCode') itemCode: string) {
    return this.service.findBuItemMaps(itemCode);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':itemCode/bu-mappings/:mapId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '사업부 간 품목 매핑 삭제' })
  removeBuMapping(
    @Param('itemCode') itemCode: string,
    @Param('mapId', ParseIntPipe) mapId: number
  ) {
    return this.service.removeBuItemMap(itemCode, BigInt(mapId));
  }
}
