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
import { CodeGroupService } from './code-group.service';
import { CreateCodeGroupDto, UpdateCodeGroupDto } from './dto/code-group.dto';

@ApiTags('기준정보 — 공통코드(코드그룹)')
@Controller('master/code-groups')
export class CodeGroupController {
  constructor(private readonly service: CodeGroupService) {}

  @Post()
  @ApiOperation({ summary: '코드그룹 등록' })
  @ApiResponse({ status: 201, description: '등록 성공' })
  @ApiResponse({ status: 409, description: '코드그룹 중복' })
  create(@Body() dto: CreateCodeGroupDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '코드그룹 목록 조회 (페이징·검색)' })
  findAll(@Query() query: PageQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':code')
  @ApiOperation({ summary: '코드그룹 단건 조회 (사용중 코드값 포함)' })
  @ApiParam({ name: 'code', description: '코드그룹', example: 'ITEM_TYPE' })
  @ApiResponse({ status: 404, description: '코드그룹 없음' })
  findOne(@Param('code') code: string) {
    return this.service.findOne(code);
  }

  @Patch(':code')
  @ApiOperation({ summary: '코드그룹 수정' })
  @ApiResponse({ status: 409, description: 'ERP 연계 수신본은 수정 불가' })
  update(@Param('code') code: string, @Body() dto: UpdateCodeGroupDto) {
    return this.service.update(code, dto);
  }

  @Delete(':code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '코드그룹 삭제 (소프트 삭제)' })
  @ApiResponse({ status: 409, description: '하위 코드값 잔존 또는 ERP 연계 수신본' })
  remove(@Param('code') code: string) {
    return this.service.remove(code);
  }
}
