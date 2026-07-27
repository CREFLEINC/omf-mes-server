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

import {
  AddPartnerRoleDto,
  CreatePartnerDto,
  PartnerQueryDto,
  UpdatePartnerDto,
} from './partner.dto';
import { PartnerService } from './partner.service';

@ApiTags('기준정보 — 거래처')
@Controller('master/partners')
export class PartnerController {
  constructor(private readonly service: PartnerService) {}

  @Post()
  @ApiOperation({ summary: '거래처 등록 (역할 동시 부여 가능)' })
  @ApiResponse({ status: 400, description: '역할 코드값 오류' })
  @ApiResponse({ status: 409, description: '거래처 코드 중복' })
  create(@Body() dto: CreatePartnerDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '거래처 목록 — 검색은 코드·명칭·ERP 코드를 본다' })
  findAll(@Query() query: PartnerQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':partnerCode')
  @ApiOperation({ summary: '거래처 단건 조회 (역할 포함)' })
  @ApiParam({ name: 'partnerCode', example: 'SUP_0001' })
  findOne(@Param('partnerCode') partnerCode: string) {
    return this.service.findOne(partnerCode);
  }

  @Patch(':partnerCode')
  @ApiOperation({ summary: '거래처 수정' })
  update(@Param('partnerCode') partnerCode: string, @Body() dto: UpdatePartnerDto) {
    return this.service.update(partnerCode, dto);
  }

  @Delete(':partnerCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '거래처 비활성화' })
  @ApiResponse({ status: 409, description: '외부창고·품목 외부코드가 참조 중' })
  deactivate(@Param('partnerCode') partnerCode: string) {
    return this.service.deactivate(partnerCode);
  }

  // ── 역할 ──────────────────────────────────────────────────────────────

  @Post(':partnerCode/roles')
  @ApiOperation({ summary: '역할 부여' })
  @ApiResponse({ status: 409, description: '이미 부여된 역할' })
  addRole(@Param('partnerCode') partnerCode: string, @Body() dto: AddPartnerRoleDto) {
    return this.service.addRole(partnerCode, dto);
  }

  @Get(':partnerCode/roles')
  @ApiOperation({ summary: '역할 목록' })
  findRoles(@Param('partnerCode') partnerCode: string) {
    return this.service.findRoles(partnerCode);
  }

  @Delete(':partnerCode/roles/:roleTypeCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '역할 회수 (단순 매핑이라 물리 삭제)' })
  removeRole(
    @Param('partnerCode') partnerCode: string,
    @Param('roleTypeCode') roleTypeCode: string,
  ) {
    return this.service.removeRole(partnerCode, roleTypeCode);
  }
}
