import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { currentTerminal } from '../../auth/terminal-context';
import { TerminalAccessibleScreensOperation, TerminalRegistrationOperation } from '../../auth/terminal-registration-operation';
import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  TerminalCreate,
  TerminalProcessInput,
  TerminalQuery,
  TerminalService,
  TerminalUpdate,
} from './terminal.service';

/** 단말 마스터. 화면은 `W-CO-06`(단말 관리)이다. */
@Controller('mdm/terminals')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/terminals')
  list(@Query() query: TerminalQuery): Promise<PagedResponse<unknown>> {
    return this.terminals.list(query);
  }

  @Get(':terminalId')
  @Contract('GET /mdm/terminals/{terminalId}')
  async get(
    @Param('terminalId', ParseIntPipe) terminalId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { terminal, versionNo } = await this.terminals.get(terminalId);
    setEtag(response, versionNo);
    return terminal;
  }

  /** Forward-only POP navigation: current active bearer and own terminal are checked in the auth guard. */
  @Get(':terminalId/accessible-screens')
  @TerminalAccessibleScreensOperation()
  accessibleScreens(@Res({ passthrough: true }) response: Response): { screenCodes: string[] } {
    response.setHeader('Cache-Control', 'private, no-store');
    return { screenCodes: ['P-01-01'] };
  }

  @Post()
  @Contract('POST /mdm/terminals')
  create(@Req() request: Request, @Body() body: TerminalCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.terminals.create(body),
    );
  }

  @Put(':terminalId')
  @Contract('PUT /mdm/terminals/{terminalId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('terminalId', ParseIntPipe) terminalId: number,
    @Body() body: TerminalUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'terminal', (version) =>
      this.terminals.update(terminalId, version, body),
    );
  }

  @Post(':terminalId\\:deactivate')
  @Contract('POST /mdm/terminals/{terminalId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('terminalId', ParseIntPipe) terminalId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'terminal', (version) =>
      this.terminals.deactivate(terminalId, version),
    );
  }

  /**
   * ⛔ `If-Match` 가 없다 — 계약이 이 자리에 요구하지 않았다. 재발급은 「지금 상태를
   * 고치는 것」이 아니라 「새 세대를 여는 것」이라, 낡은 화면에서 눌러도 결과가 같다.
   * 멱등키는 요구하므로 두 번 눌러 두 세대가 생기는 것은 막힌다.
   */
  @Post(':terminalId\\:issue-token')
  @Contract('POST /mdm/terminals/{terminalId}:issue-token')
  @HttpCode(HttpStatus.CREATED)
  issueToken(
    @Req() request: Request,
    @Param('terminalId', ParseIntPipe) terminalId: number,
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.terminals.issueToken(terminalId),
    );
  }

  /** Forward-only operation; the design contract copy does not yet define it. */
  @Post(':terminalId\\:confirm-registration')
  @TerminalRegistrationOperation()
  @HttpCode(HttpStatus.OK)
  confirmRegistration(
    @Req() request: Request,
    @Param('terminalId', ParseIntPipe) terminalId: number,
    @Body() body: unknown,
  ): Promise<unknown> {
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: idempotencyKey ? ERROR_CODE.INVALID : ERROR_CODE.REQUIRED,
          message: 'Idempotency-Key 헤더에 UUID가 필요합니다.' },
      ]);
    }
    if (body !== undefined && (body === null || typeof body !== 'object'
      || Array.isArray(body) || Object.keys(body).length !== 0)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.INVALID, message: '등록 확인 본문은 비어 있어야 합니다.' },
      ]);
    }
    const terminal = currentTerminal(request);
    if (!terminal) {
      throw new ContractException(HttpStatus.UNAUTHORIZED, [
        { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증이 필요합니다.' },
      ]);
    }
    return this.terminals.confirmRegistration(terminalId, terminal);
  }

  @Get(':terminalId/processes')
  @Contract('GET /mdm/terminals/{terminalId}/processes')
  async listProcesses(
    @Param('terminalId', ParseIntPipe) terminalId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { items, versionNo } = await this.terminals.listProcesses(terminalId);
    setEtag(response, versionNo);
    return { items };
  }

  @Put(':terminalId/processes')
  @Contract('PUT /mdm/terminals/{terminalId}/processes')
  async replaceProcesses(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('terminalId', ParseIntPipe) terminalId: number,
    @Body() body: { items: TerminalProcessInput[] },
  ): Promise<unknown> {
    const items = await runVersioned(this.idempotency, request, response, 'items', (version) =>
      this.terminals.replaceProcesses(
        terminalId,
        version,
        body.items,
        currentSession(request)?.userId,
      ),
    );
    return { items };
  }
}
