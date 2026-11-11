import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ItemGroupDefectRow, readItemGroupDefectRows, readItemGroupRows } from './dashboard-item-group';
import { dashboardScope } from './dashboard-scope';
import type { DashboardSummaryQuery } from './dashboard-summary.service';
import type { DefectPhenomenon, ItemGroupProduction } from './dashboard-sections';
import { itemGroupProduction } from './dashboard-view';

export interface ItemGroupDefects extends Omit<ItemGroupProduction, 'goodQty'> {
  /** 수량 많은 순 상위 5. */
  topDefects: DefectPhenomenon[];
  /** 상위 5 밖 유형들의 수량 합. */
  otherTypedQty: number;
  /** NG − 유형이 적힌 불량 수량(0 이상) — 폐기·재작업 수량이나 유형 없이 들어온 불량은 기록이 없다. */
  untypedNgQty: number;
}

export interface DashboardItemGroupDefects {
  dateFrom: string;
  dateTo: string;
  asOf: string;
  groups: ItemGroupDefects[];
}

const TOP = 5;

/** 종합 불량률을 누르면 여는 제품군별 불량 현황 — 생산 합은 대시보드 요약의 `production.byItemGroup` 과 같은 값이다. */
@Injectable()
export class DashboardItemGroupDefectsService {
  constructor(private readonly prisma: PrismaService) {}

  async read(actorUserId: number, query: DashboardSummaryQuery): Promise<DashboardItemGroupDefects> {
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const { range, plants } = await dashboardScope(tx, query, now, actorUserId);
        const groups = itemGroupProduction(await readItemGroupRows(tx, plants, range));
        return {
          dateFrom: range.from,
          dateTo: range.to,
          asOf: now.toISOString(),
          groups: withDefects(groups, await readItemGroupDefectRows(tx, plants, range)),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** 제품군마다 불량 유형을 공장 사이 합쳐 상위 5 를 붙인다. 생산이 없는 제품군의 기록은 버린다(기록만으로 줄을 만들지 않는다). */
export function withDefects(groups: readonly ItemGroupProduction[], defects: readonly ItemGroupDefectRow[]): ItemGroupDefects[] {
  return groups.map(({ goodQty: _goodQty, ...group }) => {
    const byCode = new Map<bigint, DefectPhenomenon>();
    for (const row of defects.filter((item) => item.code === group.itemGroupCode)) {
      const before = byCode.get(row.defectCodeId);
      byCode.set(row.defectCodeId, {
        defectCodeId: Number(row.defectCodeId),
        defectCode: row.defectCode,
        defectName: row.defectName,
        qty: (before?.qty ?? 0) + row.qty,
      });
    }
    const all = [...byCode.values()].sort((a, b) => b.qty - a.qty || a.defectCode.localeCompare(b.defectCode));
    const typed = all.reduce((sum, row) => sum + row.qty, 0);
    const top = all.slice(0, TOP);
    return {
      ...group,
      topDefects: top,
      otherTypedQty: typed - top.reduce((sum, row) => sum + row.qty, 0),
      untypedNgQty: Math.max(0, group.ngQty - typed),
    };
  });
}
