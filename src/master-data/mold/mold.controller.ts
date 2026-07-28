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

import { CreateMoldDto, MoldQueryDto, UpdateMoldDto } from './mold.dto';
import { MoldService } from './mold.service';

@ApiTags('기준정보 — 툴·금형')
@Controller('master/molds')
export class MoldController {
  constructor(private readonly service: MoldService) {}

  @RequirePermissions('MASTER_EQUIPMENT_WRITE')
  @Post()
  @ApiOperation({ summary: '금형 등록' })
  @ApiResponse({ status: 400, description: '상태 코드값 오류 · Cavity 수 0 이하' })
  @ApiResponse({ status: 409, description: '금형 코드 중복' })
  create(@Body() dto: CreateMoldDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '금형 목록 — 공장·상태·누적 타발수로 좁힐 수 있다' })
  findAll(@Query() query: MoldQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':moldCode')
  @ApiOperation({ summary: '금형 단건 조회' })
  @ApiParam({ name: 'moldCode', example: 'MOLD_A01' })
  @ApiResponse({ status: 409, description: '금형코드가 여러 공장에 존재 — 공장 지정 필요' })
  findOne(@Param('moldCode') moldCode: string) {
    return this.service.findOne(moldCode);
  }

  @RequirePermissions('MASTER_EQUIPMENT_WRITE')
  @Patch(':moldCode')
  @ApiOperation({ summary: '금형 수정' })
  update(@Param('moldCode') moldCode: string, @Body() dto: UpdateMoldDto, @ActorId() actor?: bigint) {
    return this.service.update(moldCode, dto, actor);
  }

  @RequirePermissions('MASTER_EQUIPMENT_DEACTIVATE')
  @Delete(':moldCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '금형 비활성화' })
  deactivate(@Param('moldCode') moldCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(moldCode, actor);
  }
}
