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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { MoldCreate, MoldQuery, MoldService, MoldWrite } from './mold.service';

/**
 * 툴 마스터. 화면은 `W-05-13`(툴 마스터)이 쓰고 목록은 `W-05-02`(예방보전 도래 조회)·
 * 툴 보전오더 생성 화면이 같은 경로를 필터만 바꿔 부른다.
 */
/**
 * 읽고 버리는 입력이라 메모리로 받는다 — 상한을 두지 않으면 큰 파일 하나로 서버가
 * 넘어간다. 툴 대장은 수천 행이라 넉넉하다.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Controller('mdm/molds')
export class MoldController {
  constructor(
    private readonly molds: MoldService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/molds')
  list(@Query() query: MoldQuery): Promise<unknown> {
    return this.molds.list(query);
  }

  @Get(':moldId')
  @Contract('GET /mdm/molds/{moldId}')
  async get(
    @Param('moldId', ParseIntPipe) moldId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { mold, editability, labelIssueCount, versionNo } = await this.molds.get(moldId);
    setEtag(response, versionNo);
    return { mold, editability, labelIssueCount };
  }

  @Post()
  @Contract('POST /mdm/molds')
  create(@Req() request: Request, @Body() body: MoldCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.molds.create(body),
    );
  }

  @Put(':moldId')
  @Contract('PUT /mdm/molds/{moldId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('moldId', ParseIntPipe) moldId: number,
    @Body() body: MoldWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'mold', (version) =>
      this.molds.update(moldId, version, body),
    );
  }

  @Post(':moldId\\:activate')
  @Contract('POST /mdm/molds/{moldId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('moldId', ParseIntPipe) moldId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'mold', (version) =>
      this.molds.setActive(moldId, version, true),
    );
  }

  @Post(':moldId\\:deactivate')
  @Contract('POST /mdm/molds/{moldId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('moldId', ParseIntPipe) moldId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'mold', (version) =>
      this.molds.setActive(moldId, version, false),
    );
  }

  @Post(':moldId\\:dispose')
  @Contract('POST /mdm/molds/{moldId}:dispose')
  @HttpCode(HttpStatus.OK)
  dispose(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('moldId', ParseIntPipe) moldId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'mold', (version) =>
      this.molds.dispose(moldId, version),
    );
  }
}

/**
 * ⛔ 컬렉션에 붙는 액션(`/molds:import`)은 **컨트롤러 접두어를 짧게 잡아야** 한다.
 * Nest 는 컨트롤러 경로와 메서드 경로를 «슬래시로» 잇기 때문에, `@Controller('mdm/molds')`
 * 아래에 `@Post('\\:import')` 를 두면 `mdm/molds/:import` 가 되어 안 맞는다.
 * 연계 메시지 `:retry-batch` 와 같은 이유로 한 단계 위에서 전체 경로를 적는다.
 */
@Controller('mdm')
export class MoldImportController {
  constructor(
    private readonly molds: MoldService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * 엑셀 대장 올리기. 전 계약에서 처음 두는 파일 올리기 경로다 — 첨부와 «다른 자리»다
   * (첨부는 보관되는 파일이고 이것은 읽고 버리는 입력이다 · 계약 x-internal-note).
   */
  @Post('molds\\:import')
  @Contract('POST /mdm/molds:import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@Req() request: Request, @UploadedFile() file?: Express.Multer.File): Promise<unknown> {
    if (file === undefined) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.REQUIRED, message: '엑셀 파일이 없습니다.' },
      ]);
    }
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.molds.importWorkbook(file.buffer),
    );
  }
}
