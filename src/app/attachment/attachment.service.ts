import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { attachmentRoot, readAttachment } from '../../common/attachment-storage';
import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentView, attachmentView } from './attachment-view';

export interface AttachmentContent {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
}

/** 질의 둘 — `page`·`size`·기간이 계약에 없다(I-34.md §1-2 실측). */
export interface AttachmentQuery {
  targetTypeCode?: string;
  targetId?: number;
}

/** 시각 칸 있는 목록의 0단계 선례 — `notification-query.service.ts:42` 등과 같다. */
export const ATTACHMENT_ORDER_BY: Prisma.attachmentOrderByWithRelationInput[] = [
  { uploaded_at: 'desc' },
  { attachment_id: 'desc' },
];

/**
 * `targetTypeCode`·`targetId` 는 «독립 필터 둘»이다 — 하나만 와도 400 이 아니다
 * (계약이 200 만 선언해 짝을 강제하면 없는 400 을 서버가 만든다 · §0 자리 1).
 * 형제 `approval-request.service.ts:149-150` 과 같은 판정.
 */
export function buildAttachmentWhere(query: AttachmentQuery): Prisma.attachmentWhereInput {
  return {
    ...(query.targetTypeCode === undefined ? {} : { target_type_code: query.targetTypeCode }),
    ...(query.targetId === undefined ? {} : { target_id: query.targetId }),
  };
}

/**
 * 첨부 목록 조회(I-34 PR ①) — `judgment-type-control.service.ts:44-61` 의 직역 복제.
 * ⛔ `common/pagination` 을 부르지 않는다 — 그 헬퍼의 `DEFAULT_SIZE = 50` 이 계약에
 * 없는 상한을 조용히 만든다(§0 자리 2). 이 오퍼레이션은 전건을 낸다.
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 첨부 바이트(#652). 행이 없어도, 행은 있는데 파일이 없어도 404 다 — 계약이 404 만 선언했다.
   * 파일이 없는 것은 볼륨이 빠진 배포일 수 있어 경고를 남긴다(500 으로 숨기지 않는다).
   */
  async content(attachmentId: number): Promise<AttachmentContent> {
    const row = await this.prisma.attachment.findUnique({
      where: { attachment_id: attachmentId },
      select: { storage_key: true, file_name: true, mime_type: true },
    });
    if (!row) throw new NotFoundException('없는 첨부입니다.');
    const bytes = await readAttachment(attachmentRoot(), row.storage_key);
    if (!bytes) {
      this.logger.warn(`첨부 ${String(attachmentId)} 의 파일이 저장 경로에 없습니다: ${row.storage_key}`);
      throw new NotFoundException('첨부 파일이 없습니다.');
    }
    return { bytes, fileName: row.file_name, mimeType: row.mime_type };
  }

  async list(query: AttachmentQuery): Promise<{ items: AttachmentView[] }> {
    const rows = await this.prisma.attachment.findMany({
      where: buildAttachmentWhere(query),
      orderBy: ATTACHMENT_ORDER_BY,
    });
    return { items: rows.map(attachmentView) };
  }
}
