import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';

import { ATTACHMENT_UPLOAD_OPTIONS } from '../../common/attachment-storage';
import { Contract } from '../../common/contract';
import { AttachmentUploadService } from './attachment-upload.service';
import { AttachmentQuery, AttachmentService } from './attachment.service';
import { AttachmentView } from './attachment-view';

/** 계약이 선언한 이미지 두 가지만 그대로 싣고, 나머지는 브라우저가 실행하지 않게 내려받기로 준다. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * 첨부 — 다형 참조(`targetTypeCode`,`targetId`)라 기존 `notice`·`access` 등 어디에도 안 붙는다.
 * 목록(I-34)은 403·ETag·멱등이 없다 — 계약이 200 하나만 선언한다.
 * 올리기·내려받기(#652)는 창고 도면·공지 첨부다. 고장 사진은 전용 경로(`POST /maintenance/breakdowns/{id}/attachments`)로
 * 올리고 내려받기는 이 경로를 함께 쓴다. 내려받기는 계약이 403 을 선언하지 않아 로그인 세션이면 받는다.
 */
@Controller('app/attachments')
export class AttachmentController {
  constructor(
    private readonly attachments: AttachmentService,
    private readonly uploads: AttachmentUploadService,
  ) {}

  @Get()
  @Contract('GET /app/attachments')
  list(@Query() query: AttachmentQuery): Promise<{ items: AttachmentView[] }> {
    return this.attachments.list(query);
  }

  @Post()
  @Contract('POST /app/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', ATTACHMENT_UPLOAD_OPTIONS))
  upload(
    @Req() request: Request,
    @Body() body: unknown,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<AttachmentView> {
    return this.uploads.upload(body, file, request);
  }

  /** 헤더를 쓰기 전에 모든 예외를 던진다 — 404 가 전역 필터의 ErrorResponse 로 나간다. */
  @Get(':attachmentId/content')
  @Contract('GET /app/attachments/{attachmentId}/content')
  async content(@Param('attachmentId') attachmentId: number, @Res() response: Response): Promise<void> {
    const { bytes, fileName, mimeType } = await this.attachments.content(attachmentId);
    const inline = INLINE_TYPES.has(mimeType);
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', inline ? mimeType : 'application/octet-stream');
    response.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', fileName));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(bytes);
  }
}

/** RFC 6266 — ASCII 대체 이름과 RFC 5987 `filename*` 을 함께 싣는다(한글 파일 이름). */
function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
