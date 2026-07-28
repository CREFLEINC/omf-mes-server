import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentTerminal, TerminalAuth } from '../auth/terminal-auth.decorators';
import { TerminalPrincipal } from '../auth/terminal-auth.service';
import {
  IdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from '../common/idempotency/idempotency.decorators';
import { CreateProductionResultDto } from './production-result.dto';
import { ProductionResultService } from './production-result.service';

/** 생산실적 — WF02 S7. 작업 세션에 만든 수량을 매단다. */
@ApiTags('POP — 현장 단말')
@TerminalAuth()
@Controller('pop/work-sessions')
export class ProductionResultController {
  constructor(private readonly service: ProductionResultService) {}

  @Post(':workSessionId/results')
  @ApiOperation({
    summary: '생산실적 등록 — 양품 수량',
    description:
      '작업자·근무조·설비·금형은 작업 세션에서 승계하므로 수량만 보낸다. ' +
      '지시수량 초과는 막지 않는다 — 초과분은 추가 생산LOT 발행으로 처리하는 것이 확정 설계다. ' +
      '불량·손실 수량은 PQC(02-S-E) 소관이라 여기서 받지 않는다.',
  })
  @ApiParam({ name: 'workSessionId', example: 1 })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      '재전송 식별자(클라이언트 UUID). 같은 키로 다시 보내면 새로 만들지 않고 처음 만든 ' +
      '실적을 그대로 돌려준다(응답의 replayed=true). 오프라인 구간 재전송에 필요하다.',
    example: '9f1c0f6e-6a2b-4a5e-9c3d-0b1f2a3d4e5f',
  })
  @ApiResponse({ status: 201, description: '등록됨 · 또는 재전송으로 기존 실적 반환' })
  @ApiResponse({ status: 400, description: 'Idempotency-Key 헤더 없음 · 수량이 0 이하' })
  @ApiResponse({ status: 403, description: '다른 공장 · 닫힌 세션 · 실적 입력 미허용 공정' })
  @ApiResponse({ status: 404, description: '작업 세션 없음 · 채번규칙 없음' })
  @ApiResponse({ status: 409, description: '다른 요청에 이미 사용된 Idempotency-Key' })
  create(
    @CurrentTerminal() terminal: TerminalPrincipal,
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: CreateProductionResultDto,
  ) {
    return this.service.create(terminal, BigInt(workSessionId), idempotencyKey, dto);
  }
}
