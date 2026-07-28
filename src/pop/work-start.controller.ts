import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  CurrentTerminal,
  TerminalAuth,
  WorkerNo,
  WORKER_NO_HEADER,
} from '../auth/terminal-auth.decorators';
import { TerminalPrincipal } from '../auth/terminal-auth.service';
import { PopWorkOrderQueryDto, StartWorkDto } from './work-start.dto';
import { WorkStartService } from './work-start.service';

/**
 * 작업 시작 — WF02 S5·S6. 사번 입력(→ `GET /pop/context`) 다음에 오는 두 화면이다.
 * 여기서 열린 작업 세션에 이후의 실적·불량·자재투입이 매달린다.
 */
@ApiTags('POP — 현장 단말')
@TerminalAuth()
@Controller('pop/work-orders')
export class WorkStartController {
  constructor(private readonly service: WorkStartService) {}

  @Get()
  @ApiOperation({
    summary: '시작 가능한 작업지시 목록',
    description:
      '내 단말이 담당하면서 「작업 시작」이 허용된 공정의, 배포된 작업지시만 돌려준다. ' +
      '우선순위·계획 시작 순으로 정렬한다.',
  })
  @ApiResponse({ status: 403, description: '단말이 시작할 수 없는 공정을 지정' })
  findStartable(
    @CurrentTerminal() terminal: TerminalPrincipal,
    @Query() query: PopWorkOrderQueryDto,
  ) {
    return this.service.findStartable(terminal, query);
  }

  @Post(':workOrderId/start')
  @ApiOperation({
    summary: '작업 시작 — 작업 세션을 연다',
    description:
      '4M은 작업지시의 계획값을 승계한다. 계획과 다르게 투입할 때만 본문에 코드를 지정한다. ' +
      '작업자 자격은 운영정책 WORKER_QUALIFICATION_ENFORCEMENT가 정한 수준(BLOCK·WARN·OFF)으로 ' +
      '검증하고, WARN이면 warnings에 사유를 실어 시작시킨다.',
  })
  @ApiParam({ name: 'workOrderId', example: 1 })
  @ApiHeader({
    name: WORKER_NO_HEADER,
    required: true,
    description: '작업자 사번 — 실적 귀속 대상',
    example: 'EMP-1043',
  })
  @ApiResponse({ status: 400, description: '사번 헤더 없음 · 근무조 미결정 · 필수 설비/금형 미지정' })
  @ApiResponse({ status: 403, description: '다른 공장·미허용 공정 · 배포되지 않은 상태 · 자격 미달(BLOCK)' })
  @ApiResponse({ status: 404, description: '작업지시·근무조·설비·금형 없음' })
  @ApiResponse({ status: 409, description: '이미 진행 중인 작업' })
  start(
    @CurrentTerminal() terminal: TerminalPrincipal,
    @WorkerNo() workerNo: string | undefined,
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @Body() dto: StartWorkDto,
  ) {
    return this.service.start(terminal, workerNo, BigInt(workOrderId), dto);
  }
}
