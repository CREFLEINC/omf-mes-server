import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { AttachmentQuery, AttachmentService } from './attachment.service';
import { AttachmentView } from './attachment-view';

/**
 * 첨부 목록(I-34 PR ①) — 다형 참조(`targetTypeCode`,`targetId`)라 기존 `notice`·
 * `access` 등 어디에도 안 붙는다(§0 자리 5). 업로드·다운로드·고장 첨부 3건은 건너뜀
 * 확정이라(바이너리 저장소가 DB 밖) 여기 없다.
 * ⛔ 403·ETag·멱등 없음 — 계약이 200 하나만 선언한다.
 */
@Controller('app/attachments')
export class AttachmentController {
  constructor(private readonly attachments: AttachmentService) {}

  @Get()
  @Contract('GET /app/attachments')
  list(@Query() query: AttachmentQuery): Promise<{ items: AttachmentView[] }> {
    return this.attachments.list(query);
  }
}
