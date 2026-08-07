import { Controller, Get, Header, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { RequirePermissions } from '../../auth/auth.decorators';
import type { components } from '../../contracts/mdm';
import { CodeGroupQueryDto, CodeValueQueryDto } from './code.query.dto';
import { CodeService } from './code.service';

/**
 * 조회만 있다. 계약에는 등록·수정·중지 6개가 더 있으나 만들지 않는다 —
 * 공통코드는 시스템 수준 상수이고 마이그레이션·시드로만 들어온다. 그룹 코드는
 * `warehouse.validator.ts` 등 소스에 문자열로 박혀 있어 화면에서 바꾸면 그 마스터의
 * 등록이 전부 막힌다. 계약 소유자에게 되돌릴 항목이다(계획서 미결).
 */
@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm')
export class CodeController {
  constructor(private readonly service: CodeService) {}

  @Get('code-groups')
  @ApiOperation({ summary: '코드그룹 목록' })
  findGroups(@Query() query: CodeGroupQueryDto) {
    return this.service.findGroups(query);
  }

  @Get('code-groups/:codeGroupId')
  @ApiOperation({ summary: '코드그룹 상세' })
  @ApiResponse({ status: 404, description: '없는 코드그룹' })
  @Header('Cache-Control', 'no-store')
  async findGroup(
    @Param('codeGroupId', ParseIntPipe) codeGroupId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['CodeGroupDetailResponse']> {
    const { body, versionNo } = await this.service.findGroup(BigInt(codeGroupId));

    response.setHeader('ETag', String(versionNo));

    return body;
  }

  @Get('code-values')
  @ApiOperation({ summary: '코드값 목록 — codeGroupId 필수' })
  findValues(@Query() query: CodeValueQueryDto) {
    return this.service.findValues(query);
  }

  @Get('code-values/:codeValueId')
  @ApiOperation({ summary: '코드값 상세' })
  @ApiResponse({ status: 404, description: '없는 코드값' })
  @Header('Cache-Control', 'no-store')
  async findValue(
    @Param('codeValueId', ParseIntPipe) codeValueId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['CodeValueDetailResponse']> {
    const { body, versionNo } = await this.service.findValue(BigInt(codeValueId));

    response.setHeader('ETag', String(versionNo));

    return body;
  }
}
