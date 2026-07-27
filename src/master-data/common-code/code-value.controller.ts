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
import { CodeValueService } from './code-value.service';
import { CreateCodeValueDto, UpdateCodeValueDto } from './dto/code-value.dto';

@ApiTags('기준정보 — 공통코드(코드값)')
@ApiParam({ name: 'groupCode', description: '코드그룹', example: 'ITEM_TYPE' })
@Controller('master/code-groups/:groupCode/values')
export class CodeValueController {
  constructor(private readonly service: CodeValueService) {}

  @Post()
  @ApiOperation({ summary: '코드값 등록' })
  @ApiResponse({ status: 409, description: '코드값 중복' })
  create(@Param('groupCode') groupCode: string, @Body() dto: CreateCodeValueDto) {
    return this.service.create(groupCode, dto);
  }

  @Get()
  @ApiOperation({ summary: '코드값 목록 조회 (페이징·검색)' })
  findAll(@Param('groupCode') groupCode: string, @Query() query: PageQueryDto) {
    return this.service.findAll(groupCode, query);
  }

  @Get(':code')
  @ApiOperation({ summary: '코드값 단건 조회' })
  @ApiParam({ name: 'code', description: '코드값', example: 'RAW' })
  findOne(@Param('groupCode') groupCode: string, @Param('code') code: string) {
    return this.service.findOne(groupCode, code);
  }

  @Patch(':code')
  @ApiOperation({ summary: '코드값 수정' })
  update(
    @Param('groupCode') groupCode: string,
    @Param('code') code: string,
    @Body() dto: UpdateCodeValueDto,
  ) {
    return this.service.update(groupCode, code, dto);
  }

  @Delete(':code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '코드값 비활성화 (is_active=false)' })
  remove(@Param('groupCode') groupCode: string, @Param('code') code: string) {
    return this.service.deactivate(groupCode, code);
  }
}
