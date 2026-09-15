import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { ATTACHMENT_UPLOAD_OPTIONS } from '../../common/attachment-storage';
import { Contract } from '../../common/contract';
import { AttachmentUploadService } from './attachment-upload.service';
import { AttachmentQuery, AttachmentService } from './attachment.service';
import { AttachmentView } from './attachment-view';

/**
 * 첨부 — 다형 참조(`targetTypeCode`,`targetId`)라 기존 `notice`·`access` 등 어디에도 안 붙는다.
 * 목록(I-34)은 403·ETag·멱등이 없다 — 계약이 200 하나만 선언한다.
 * 올리기(#652)는 창고 도면·공지 첨부를 받는다. 고장 사진은 전용 경로(`POST /maintenance/breakdowns/{id}/attachments`)다.
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
}
