import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { InboundVarianceView, inboundVarianceView } from './inbound-variance-view';

/** 입하 차이 조회 — 화면 `M-01-06`. 등록만 있고 수정·삭제는 없다(계약 · 다른 PR 몫). */
@Injectable()
export class InboundVarianceService {
  constructor(private readonly prisma: PrismaService) {}

  /** 없는 라인이면 빈 배열이다 — 계약이 이 경로에 404 를 선언하지 않았다(P/O `lines()` 선례). */
  async list(inboundReceiptLineId: number): Promise<InboundVarianceView[]> {
    const rows = await this.prisma.inbound_variance.findMany({
      where: { inbound_receipt_line_id: inboundReceiptLineId },
      orderBy: { inbound_variance_id: 'asc' },
    });
    return rows.map(inboundVarianceView);
  }
}
