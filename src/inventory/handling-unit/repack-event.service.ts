import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  HandlingUnitRepackEventView,
  REPACK_EVENT_INCLUDE,
  repackEventView,
} from './repack-event-view';

/**
 * `GET /inventory/handling-units/{handlingUnitId}/repack-events`(PR ②).
 * 계획 `docs/coverage-100/slices/I-16-a2.md` §6-4.
 */
@Injectable()
export class RepackEventService {
  constructor(private readonly prisma: PrismaService) {}

  async list(handlingUnitId: number): Promise<HandlingUnitRepackEventView[]> {
    // 계약 미선언이나 404 를 낸다(형제 자식 조회 선례 · §10-3 ⓐ).
    const exists = await this.prisma.handling_unit.findUnique({
      where: { handling_unit_id: handlingUnitId },
      select: { handling_unit_id: true },
    });
    if (!exists) throw new NotFoundException('없는 취급 단위입니다.');

    const rows = await this.prisma.handling_unit_repack_event.findMany({
      // ⭐ 헤더가 아니라 «라인»으로 건다 — MERGE 는 원본이 여럿이라 헤더 한 칸으로 못
      //    가리킨다(계약 라인 `handlingUnitId` required · 그래서 헤더에 그 칸이 없다).
      where: { lines: { some: { handling_unit_id: handlingUnitId } } },
      include: REPACK_EVENT_INCLUDE,
      // ⭐ 2차 키가 «필수»다 — `occurred_at` 은 서버가 심는 값이라 같은 순간에 둘이
      //    들어올 수 있고, 그때 1차 키만으로는 순서가 안 정해진다(I-13 실사고).
      orderBy: [{ occurred_at: 'desc' }, { handling_unit_repack_event_id: 'desc' }],
    });
    // ⛔ 응답에 `page` 가 없다(계약 `{items[]}` 뿐) — 상한·필터를 지어내지 않고 전건을
    //    내린다(통보 144 ⓐ).
    return rows.map(repackEventView);
  }
}
