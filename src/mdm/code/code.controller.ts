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

import { Contract } from '../../common/contract';
import { IdempotencyService, requestFingerprint } from '../../common/idempotency';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { currentSession } from '../../auth/session-resolver.service';
import { ReferenceQuery } from '../reference/reference.query';
import { CodeService } from './code.service';

/**
 * 공통코드 마스터. 화면은 `W-06-06`(공통코드·조직·작업자 마스터) 하나가 소유한다.
 *
 * 쓰기 여섯은 계약이 `Idempotency-Key` 를 요구하고, 수정·전이 넷은 `If-Match` 도 요구한다.
 * 헤더가 있는지는 가드가 이미 보았으므로(`#106`·`#107`) 여기서는 **값을 쓴다.**
 */
@Controller('mdm')
export class CodeController {
  constructor(
    private readonly codes: CodeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ── 코드 그룹 ────────────────────────────────────────────────────────────

  @Get('code-groups')
  @Contract('GET /mdm/code-groups')
  listGroups(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.codes.listGroups(query);
  }

  @Get('code-groups/:codeGroupId')
  @Contract('GET /mdm/code-groups/{codeGroupId}')
  async getGroup(
    @Param('codeGroupId', ParseIntPipe) codeGroupId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { codeGroup, editability, versionNo } = await this.codes.getGroup(codeGroupId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    // ⛔ 상세만 래퍼다(`CodeGroupDetailResponse`). 수정·전이는 본체를 낸다 — 계약이 그렇게 갈랐다.
    return { codeGroup, editability };
  }

  @Post('code-groups')
  @Contract('POST /mdm/code-groups')
  createGroup(@Req() request: Request, @Body() body: CodeGroupWrite): Promise<unknown> {
    return this.run(request, HttpStatus.CREATED, () => this.codes.createGroup(body));
  }

  @Put('code-groups/:codeGroupId')
  @Contract('PUT /mdm/code-groups/{codeGroupId}')
  async updateGroup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeGroupId', ParseIntPipe) codeGroupId: number,
    @Body() body: CodeGroupWrite,
  ): Promise<unknown> {
    return this.runVersioned(request, response, 'codeGroup', (version) =>
      this.codes.updateGroup(codeGroupId, version, body),
    );
  }

  @Post('code-groups/:codeGroupId\\:activate')
  @Contract('POST /mdm/code-groups/{codeGroupId}:activate')
  @HttpCode(HttpStatus.OK)
  activateGroup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeGroupId', ParseIntPipe) codeGroupId: number,
  ): Promise<unknown> {
    return this.runVersioned(request, response, 'codeGroup', (version) =>
      this.codes.setGroupActive(codeGroupId, version, true),
    );
  }

  @Post('code-groups/:codeGroupId\\:deactivate')
  @Contract('POST /mdm/code-groups/{codeGroupId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivateGroup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeGroupId', ParseIntPipe) codeGroupId: number,
  ): Promise<unknown> {
    return this.runVersioned(request, response, 'codeGroup', (version) =>
      this.codes.setGroupActive(codeGroupId, version, false),
    );
  }

  // ── 코드 값 ──────────────────────────────────────────────────────────────

  @Get('code-values')
  @Contract('GET /mdm/code-values')
  listValues(
    @Query() query: ReferenceQuery & { codeGroupId?: number; codeGroupCode?: string },
  ): Promise<PagedResponse<unknown>> {
    return this.codes.listValues(query);
  }

  @Get('code-values/:codeValueId')
  @Contract('GET /mdm/code-values/{codeValueId}')
  async getValue(
    @Param('codeValueId', ParseIntPipe) codeValueId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { codeValue, editability, versionNo } = await this.codes.getValue(codeValueId);
    setEtag(response, versionNo);
    return { codeValue, editability };
  }

  @Post('code-values')
  @Contract('POST /mdm/code-values')
  createValue(@Req() request: Request, @Body() body: CodeValueCreate): Promise<unknown> {
    return this.run(request, HttpStatus.CREATED, () => this.codes.createValue(body));
  }

  @Put('code-values/:codeValueId')
  @Contract('PUT /mdm/code-values/{codeValueId}')
  updateValue(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeValueId', ParseIntPipe) codeValueId: number,
    @Body() body: CodeValueUpdate,
  ): Promise<unknown> {
    return this.runVersioned(request, response, 'codeValue', (version) =>
      this.codes.updateValue(codeValueId, version, body),
    );
  }

  @Post('code-values/:codeValueId\\:activate')
  @Contract('POST /mdm/code-values/{codeValueId}:activate')
  @HttpCode(HttpStatus.OK)
  activateValue(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeValueId', ParseIntPipe) codeValueId: number,
  ): Promise<unknown> {
    return this.runVersioned(request, response, 'codeValue', (version) =>
      this.codes.setValueActive(codeValueId, version, true),
    );
  }

  @Post('code-values/:codeValueId\\:deactivate')
  @Contract('POST /mdm/code-values/{codeValueId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivateValue(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeValueId', ParseIntPipe) codeValueId: number,
  ): Promise<unknown> {
    return this.runVersioned(request, response, 'codeValue', (version) =>
      this.codes.setValueActive(codeValueId, version, false),
    );
  }

  // ── 공통 ────────────────────────────────────────────────────────────────

  /** 멱등 흡수. 같은 키로 다시 오면 앞의 응답을 그대로 준다. */
  private async run<T>(
    request: Request,
    successStatus: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const outcome = await this.idempotency.run(
      {
        key: String(request.headers['idempotency-key']),
        fingerprint: requestFingerprint(`${request.method} ${request.path}`, request.body),
        successStatus,
        ...(currentSession(request) === undefined
          ? {}
          : { appUserId: currentSession(request)?.userId }),
      },
      () => work(),
    );
    return outcome.body;
  }

  /** 멱등 + 낙관적 잠금. 새 `version_no` 를 ETag 로 돌려준다. */
  private async runVersioned<T, K extends string>(
    request: Request,
    response: Response,
    field: K,
    work: (version: number) => Promise<{ versionNo: number } & Record<K, T>>,
  ): Promise<T> {
    // 가드가 이 자리들에서 If-Match 를 이미 필수로 막았다(`#107`) — 여기 오면 값이 있다.
    const version = ifMatchVersion(request);
    if (version === undefined) {
      throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
    }

    const result = await this.run(request, HttpStatus.OK, () => work(version));
    setEtag(response, result.versionNo);
    return result[field];
  }
}

interface CodeGroupWrite {
  groupCode: string;
  groupName: string;
  description?: string | null;
}

interface CodeValueCreate {
  codeGroupId: number;
  code: string;
  codeName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  displayOrder?: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

interface CodeValueUpdate {
  code: string;
  codeName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  displayOrder: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}
