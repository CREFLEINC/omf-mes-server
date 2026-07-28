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

import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import {
  CreatePutawayRuleDto,
  PutawayRuleQueryDto,
  UpdatePutawayRuleDto,
} from './putaway-rule.dto';
import { PutawayRuleService } from './putaway-rule.service';

@ApiTags('기준정보 — 적치규칙')
@Controller('master/putaway-rules')
export class PutawayRuleController {
  constructor(private readonly service: PutawayRuleService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({
    summary: '적치규칙 등록',
    description: '로케이션을 지정하지 않으면 창고 단위 규칙이 된다. 우선순위가 작을수록 먼저 채운다.',
  })
  @ApiResponse({ status: 404, description: '품목·창고·로케이션·단위 없음' })
  @ApiResponse({ status: 409, description: '품목×창고×로케이션 중복 · 창고코드가 여러 공장에 존재' })
  create(@Body() dto: CreatePutawayRuleDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '적치규칙 목록 — 품목·창고로 좁혀 조회 (우선순위 순)' })
  findAll(@Query() query: PutawayRuleQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':ruleId')
  @ApiOperation({ summary: '적치규칙 단건 조회' })
  @ApiParam({ name: 'ruleId', example: 1 })
  findOne(@Param('ruleId', ParseIntPipe) ruleId: number) {
    return this.service.findOne(BigInt(ruleId));
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':ruleId')
  @ApiOperation({ summary: '적치규칙 수정 — 품목·창고·로케이션은 바꿀 수 없다' })
  update(
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body() dto: UpdatePutawayRuleDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(BigInt(ruleId), dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '적치규칙 비활성화' })
  deactivate(@Param('ruleId', ParseIntPipe) ruleId: number, @ActorId() actor?: bigint) {
    return this.service.deactivate(BigInt(ruleId), actor);
  }
}
