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
  CreateOperationPolicyDto,
  EffectivePolicyQueryDto,
  OperationPolicyQueryDto,
  UpdateOperationPolicyDto,
} from './operation-policy.dto';
import { OperationPolicyService } from './operation-policy.service';

@ApiTags('기준정보 — 운영정책')
@Controller('master/operation-policies')
export class OperationPolicyController {
  constructor(private readonly service: OperationPolicyService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({
    summary: '운영정책 등록',
    description:
      '스코프(사업부·공장·품목·공정)를 지정하지 않으면 전역 기본값이 된다. ' +
      '값은 valueText·valueNumeric·valueBoolean 중 하나 이상이 필요하다.',
  })
  @ApiResponse({ status: 400, description: '정책코드 오류 · 값 미지정 · 유효기간 역전' })
  @ApiResponse({ status: 409, description: '같은 스코프·시작일의 정책 중복' })
  create(@Body() dto: CreateOperationPolicyDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '운영정책 목록 — 정책코드·공장·기준일로 좁혀 조회' })
  findAll(@Query() query: OperationPolicyQueryDto) {
    return this.service.findAll(query);
  }

  // ':policyId'(ParseIntPipe)보다 먼저 선언해야 한다 — 뒤에 두면 'effective'가
  // policyId로 잡혀 400이 난다.
  @RequirePermissions('MASTER_READ')
  @Get('effective')
  @ApiOperation({
    summary: '실제 적용값 조회 — 겹치는 정책 중 무엇이 이기는지',
    description:
      '구체적일수록 이긴다: 공정 > 품목 > 공장 > 사업부 > 전역. 같은 스코프면 늦은 시작일이 이긴다. ' +
      '해당하는 정책이 없으면 null을 돌려준다(호출 측이 기본값을 쓴다).',
  })
  effective(@Query() query: EffectivePolicyQueryDto) {
    return this.service.resolveByCodes(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':policyId')
  @ApiOperation({ summary: '운영정책 단건 조회' })
  @ApiParam({ name: 'policyId', example: 1 })
  findOne(@Param('policyId', ParseIntPipe) policyId: number) {
    return this.service.findOne(BigInt(policyId));
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':policyId')
  @ApiOperation({ summary: '운영정책 수정 — 정책코드·스코프·시작일은 바꿀 수 없다' })
  update(
    @Param('policyId', ParseIntPipe) policyId: number,
    @Body() dto: UpdateOperationPolicyDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.update(BigInt(policyId), dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':policyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '운영정책 종료 — 삭제가 아니라 종료일을 오늘로 닫는다' })
  expire(@Param('policyId', ParseIntPipe) policyId: number, @ActorId() actor?: bigint) {
    return this.service.expire(BigInt(policyId), actor);
  }
}
