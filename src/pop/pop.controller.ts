import { Controller, Get } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentTerminal, TerminalAuth, WorkerNo, WORKER_NO_HEADER } from '../auth/terminal-auth.decorators';
import { TerminalAuthService, TerminalPrincipal } from '../auth/terminal-auth.service';

/**
 * 현장 단말(POP·모바일) 진입점. 사람 로그인이 없는 대신 단말 토큰으로 인증하고,
 * 작업자 귀속은 사번 헤더로 받는다 — REQ-PR-0023 / 설계검토 §3
 */
@ApiTags('POP — 현장 단말')
@TerminalAuth()
@Controller('pop')
export class PopController {
  constructor(private readonly terminals: TerminalAuthService) {}

  @Get('context')
  @ApiOperation({
    summary: '단말 컨텍스트 — 내 단말과 허용 공정·행위',
    description:
      '단말 부팅 시 호출해 화면에 노출할 기능을 결정한다. 사번 헤더를 함께 보내면 ' +
      '해당 작업자의 귀속 가능 여부까지 확인해 돌려준다.',
  })
  @ApiHeader({
    name: WORKER_NO_HEADER,
    required: false,
    description: '작업자 사번 — 인증이 아니라 실적 귀속용',
    example: 'EMP-1043',
  })
  @ApiResponse({ status: 401, description: '단말 토큰 없음·만료 · 사용자 토큰 사용 · 폐기된 단말' })
  @ApiResponse({ status: 403, description: '등록되지 않았거나 재직 중이 아닌 사번' })
  async context(@CurrentTerminal() terminal: TerminalPrincipal, @WorkerNo() workerNo?: string) {
    const worker = workerNo ? await this.terminals.resolveWorker(workerNo) : null;

    return {
      terminal: {
        terminalCode: terminal.terminalCode,
        plantId: terminal.plantId,
        processes: terminal.processes,
      },
      worker: worker && {
        workerNo: worker.worker_no,
        workerName: worker.worker_name,
      },
    };
  }
}
