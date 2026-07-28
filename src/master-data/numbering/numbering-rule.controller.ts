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
  CreateNumberingRuleDto,
  NumberingRuleQueryDto,
  UpdateNumberingRuleDto,
} from './numbering-rule.dto';
import { NumberingRuleService } from './numbering-rule.service';

@ApiTags('기준정보 — 채번규칙')
@Controller('master/numbering-rules')
export class NumberingRuleController {
  constructor(private readonly service: NumberingRuleService) {}

  @RequirePermissions('MASTER_SYSTEM_WRITE')
  @Post()
  @ApiOperation({
    summary: '채번규칙 등록',
    description:
      '패턴 토큰은 등록 시점에 검증한다 — 발번이 시작된 뒤에 오타가 드러나면 ' +
      '이미 잘못된 번호가 찍힌 뒤다.',
  })
  @ApiResponse({ status: 400, description: '코드값 오류 · 알 수 없는 토큰 · 일련번호 토큰 개수/자리수 오류' })
  @ApiResponse({ status: 409, description: '문서유형×공장×LOT유형 중복' })
  create(@Body() dto: CreateNumberingRuleDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '채번규칙 목록 — 문서유형·공장으로 좁혀 조회' })
  findAll(@Query() query: NumberingRuleQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':ruleId')
  @ApiOperation({ summary: '채번규칙 단건 조회 (최근 카운터 20건 포함)' })
  @ApiParam({ name: 'ruleId', example: 1 })
  findOne(@Param('ruleId', ParseIntPipe) ruleId: number) {
    return this.service.findOne(BigInt(ruleId));
  }

  @RequirePermissions('MASTER_SYSTEM_WRITE')
  @Patch(':ruleId')
  @ApiOperation({ summary: '채번규칙 수정 — 문서유형·공장·LOT유형은 바꿀 수 없다' })
  @ApiResponse({ status: 409, description: '이미 발번이 시작돼 패턴·리셋주기 변경 불가' })
  update(
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body() dto: UpdateNumberingRuleDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(BigInt(ruleId), dto, actor);
  }

  @RequirePermissions('MASTER_SYSTEM_DEACTIVATE')
  @Delete(':ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '채번규칙 비활성화' })
  deactivate(@Param('ruleId', ParseIntPipe) ruleId: number, @ActorId() actor?: bigint) {
    return this.service.deactivate(BigInt(ruleId), actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':ruleId/counters')
  @ApiOperation({
    summary: '채번 카운터 조회 (읽기 전용)',
    description: '발번이 쓰는 런타임 상태다. 손으로 고치면 이미 나간 번호와 충돌해 수정·삭제는 두지 않는다.',
  })
  findCounters(@Param('ruleId', ParseIntPipe) ruleId: number) {
    return this.service.findCounters(BigInt(ruleId));
  }
}
