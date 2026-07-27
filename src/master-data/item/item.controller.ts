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

  @Post()
  @ApiOperation({ summary: '품목 등록' })
  @ApiResponse({ status: 400, description: '코드값 오류 · FEFO인데 유효기간 미지정' })
  @ApiResponse({ status: 409, description: '품목코드 중복' })
  create(@Body() dto: CreateItemDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '품목 목록' })
  findAll(@Query() query: ItemQueryDto) {
    return this.service.findAll(query, query.itemTypeCode);
  }

  @Get(':itemCode')
  @ApiOperation({ summary: '품목 단건 조회 (기본단위·단위환산·외부코드 포함)' })
  @ApiParam({ name: 'itemCode', example: 'ITEM_0001' })
  findOne(@Param('itemCode') itemCode: string) {
    return this.service.findOne(itemCode);
  }

  @Patch(':itemCode')
  @ApiOperation({ summary: '품목 수정' })
  update(@Param('itemCode') itemCode: string, @Body() dto: UpdateItemDto) {
    return this.service.update(itemCode, dto);
  }

  @Delete(':itemCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '품목 비활성화' })
  @ApiResponse({ status: 409, description: '잔량 재고 보유' })
  deactivate(@Param('itemCode') itemCode: string) {
    return this.service.deactivate(itemCode);
  }

  // ── 단위환산 ──────────────────────────────────────────────────────────

  @Post(':itemCode/uom-conversions')
  @ApiOperation({ summary: '단위환산 추가' })
  @ApiResponse({ status: 400, description: '동일 단위 · 유효기간 역전' })
  addConversion(@Param('itemCode') itemCode: string, @Body() dto: CreateUomConversionDto) {
    return this.service.addUomConversion(itemCode, dto);
  }

  @Get(':itemCode/uom-conversions')
  @ApiOperation({ summary: '단위환산 목록' })
  findConversions(@Param('itemCode') itemCode: string) {
    return this.service.findUomConversions(itemCode);
  }

  @Delete(':itemCode/uom-conversions/:conversionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '단위환산 삭제 (이력 테이블이라 물리 삭제)' })
  removeConversion(
    @Param('itemCode') itemCode: string,
    @Param('conversionId', ParseIntPipe) conversionId: number,
  ) {
    return this.service.removeUomConversion(itemCode, BigInt(conversionId));
  }

  // ── 외부 시스템 품목코드 ──────────────────────────────────────────────

  @Post(':itemCode/external-codes')
  @ApiOperation({ summary: '외부 시스템 품목코드 추가' })
  @ApiResponse({ status: 409, description: '동일 (시스템·거래처·코드) 중복' })
  addExternalCode(@Param('itemCode') itemCode: string, @Body() dto: CreateExternalCodeDto) {
    return this.service.addExternalCode(itemCode, dto);
  }

  @Get(':itemCode/external-codes')
  @ApiOperation({ summary: '외부 시스템 품목코드 목록' })
  findExternalCodes(@Param('itemCode') itemCode: string) {
    return this.service.findExternalCodes(itemCode);
  }

  @Delete(':itemCode/external-codes/:externalCodeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '외부 시스템 품목코드 삭제' })
  removeExternalCode(
    @Param('itemCode') itemCode: string,
    @Param('externalCodeId', ParseIntPipe) externalCodeId: number,
  ) {
    return this.service.removeExternalCode(itemCode, BigInt(externalCodeId));
  }

  // ── 사업부 간 품목 매핑 ───────────────────────────────────────────────

  @Post(':itemCode/bu-mappings')
  @ApiOperation({ summary: '사업부 간 품목 매핑 추가 — 매핑이 없으면 사업부 간 이동입고가 막힌다' })
  @ApiResponse({ status: 400, description: '동일 사업부 · 유효기간 역전' })
  addBuMapping(@Param('itemCode') itemCode: string, @Body() dto: CreateBuItemMapDto) {
    return this.service.addBuItemMap(itemCode, dto);
  }

  @Get(':itemCode/bu-mappings')
  @ApiOperation({ summary: '사업부 간 품목 매핑 목록' })
  findBuMappings(@Param('itemCode') itemCode: string) {
    return this.service.findBuItemMaps(itemCode);
  }

  @Delete(':itemCode/bu-mappings/:mapId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '사업부 간 품목 매핑 삭제' })
  removeBuMapping(
    @Param('itemCode') itemCode: string,
    @Param('mapId', ParseIntPipe) mapId: number,
  ) {
    return this.service.removeBuItemMap(itemCode, BigInt(mapId));
  }
}
