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
import { CreateUomDto, UpdateUomDto } from './uom.dto';
import { UomService } from './uom.service';

@ApiTags('기준정보 — 단위(UoM)')
@Controller('master/uoms')
export class UomController {
  constructor(private readonly service: UomService) {}

  @Post()
  @ApiOperation({ summary: '단위 등록' })
  @ApiResponse({ status: 409, description: '단위 코드 중복' })
  create(@Body() dto: CreateUomDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '단위 목록 (페이징·검색·사용여부)' })
  findAll(@Query() query: PageQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':uomCode')
  @ApiOperation({ summary: '단위 단건 조회' })
  @ApiParam({ name: 'uomCode', example: 'EA' })
  findOne(@Param('uomCode') uomCode: string) {
    return this.service.findOne(uomCode);
  }

  @Patch(':uomCode')
  @ApiOperation({ summary: '단위 수정' })
  update(@Param('uomCode') uomCode: string, @Body() dto: UpdateUomDto) {
    return this.service.update(uomCode, dto);
  }

  @Delete(':uomCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '단위 비활성화 (is_active=false)' })
  @ApiResponse({ status: 409, description: '품목·로케이션이 참조 중' })
  deactivate(@Param('uomCode') uomCode: string) {
    return this.service.deactivate(uomCode);
  }
}
