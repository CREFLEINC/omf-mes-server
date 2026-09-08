import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentView, attachmentView } from './attachment-view';

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
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AttachmentQuery): Promise<{ items: AttachmentView[] }> {
    const rows = await this.prisma.attachment.findMany({
      where: buildAttachmentWhere(query),
      orderBy: ATTACHMENT_ORDER_BY,
    });
    return { items: rows.map(attachmentView) };
  }
}
