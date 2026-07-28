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

import { CreateProcessDto, ProcessQueryDto, UpdateProcessDto } from './process.dto';
import { ProcessService } from './process.service';

@ApiTags('기준정보 — 공정')
@Controller('master/processes')
export class ProcessController {
  constructor(private readonly service: ProcessService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '공정 등록' })
  @ApiResponse({ status: 400, description: '공정 유형 코드값 오류' })
  @ApiResponse({ status: 409, description: '공정 코드 중복' })
  create(@Body() dto: CreateProcessDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '공정 목록' })
  findAll(@Query() query: ProcessQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':processCode')
  @ApiOperation({ summary: '공정 단건 조회' })
  @ApiParam({ name: 'processCode', example: 'MOLDING' })
  findOne(@Param('processCode') processCode: string) {
    return this.service.findOne(processCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':processCode')
  @ApiOperation({ summary: '공정 수정' })
  update(@Param('processCode') processCode: string, @Body() dto: UpdateProcessDto, @ActorId() actor?: bigint) {
    return this.service.update(processCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':processCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '공정 비활성화' })
  @ApiResponse({ status: 409, description: '라우팅·설비·작업자자격·단말이 참조 중' })
  deactivate(@Param('processCode') processCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(processCode, actor);
  }
}
