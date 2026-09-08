import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { HoldView, holdView } from './lot-view';

/**
 * `GET /trace/lots/{lotId}/holds` — 읽기만 제공한다(계약 · 보류를 걸고 푸는 것은 품질
 * 도메인의 화면이다). ⛔ `src/quality/lot-hold/lot-hold-view.ts` 의 `lotHoldView` 를
 * import 하지 않는다 — 같은 계약 스키마 `LotHold` 를 `trace` 의 `holdView`(`lot-view.ts`)
 * «하나»로만 그린다. `GET /trace/lots/{lotId}` 상세가 이미 그 뷰를 쓰므로, 같은 LOT 의
 * 같은 보류가 두 경로에서 다른 모양으로 보이면 안 된다(§0 자리 4).
 *
 * 정렬은 계약이 안 적어 0단계 선례를 그대로 쓴다 — `held_at desc, lot_hold_id desc`
 * (`lot-hold-query.service.ts:45`). R-5 로 `lot.service.ts` 의 `include: { lot_hold: true }`
 * 두 자리에도 같은 정렬을 더해 두 경로가 같은 순서를 보게 맞춘다.
 */
@Injectable()
export class LotHoldListService {
  constructor(private readonly prisma: PrismaService) {}

  async list(lotId: number, activeOnly: boolean): Promise<{ items: HoldView[] }> {
    const row = await this.prisma.lot.findUnique({
      where: { lot_id: lotId },
      include: {
        lot_hold: { orderBy: [{ held_at: 'desc' }, { lot_hold_id: 'desc' }] },
      },
    });
    if (!row) throw new NotFoundException('없는 LOT 입니다.');

    // ⭐ `activeOnly=false` 는 「해제된 것만」이 아니라 «전체»다 — 있음/없음 갈래이지
    //    참/거짓 갈래가 아니다(0단계 선례 `lot-hold-query.service.ts:68-72` · I-20 R-1).
    const holds = activeOnly ? row.lot_hold.filter((hold) => hold.released_at === null) : row.lot_hold;
    return { items: holds.map((hold) => holdView(hold, row)) };
  }
}
