import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ExternalIdentifierView, identifierView } from './lot-view';

/**
 * `GET /trace/lots/{lotId}/external-identifiers` — 조회만(PR ①). 치환(`PUT`)은 PR ② 몫이라
 * 이 파일에 아직 없다 — `lot.service.ts` 에 안 넣는 이유는 그 파일이 이미 293줄이라서다
 * (§0 자리 5 · `CLAUDE.md` ~300줄 신호).
 *
 * `list()` 는 상세 GET(`lot.service.ts:139-142`)·PUT 응답(PR ②)과 **같은 정렬·같은 뷰**를
 * 쓴다 — id 오름차순 · `identifierView`.
 */
@Injectable()
export class LotExternalIdentifierService {
  constructor(private readonly prisma: PrismaService) {}

  async list(lotId: number): Promise<{ items: ExternalIdentifierView[] }> {
    await this.assertLotExists(lotId);
    const rows = await this.prisma.lot_external_identifier.findMany({
      where: { lot_id: lotId },
      orderBy: { lot_external_identifier_id: 'asc' },
    });
    return { items: rows.map(identifierView) };
  }

  private async assertLotExists(lotId: number): Promise<void> {
    const row = await this.prisma.lot.findUnique({ where: { lot_id: lotId }, select: { lot_id: true } });
    if (!row) throw new NotFoundException('없는 LOT 입니다.');
  }
}
