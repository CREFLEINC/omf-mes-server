import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionPlanView, productionPlanView } from './production-plan-view';

/** 조회 2건(PR ①) — `POST`·`PUT`·`DELETE`·`:confirm` 은 PR ②③ 몫이다. */
export interface ProductionPlanListQuery {
  productionOrderId?: number;
  statusCode?: string;
  planDateFrom?: string;
  planDateTo?: string;
  page?: number;
  size?: number;
}

@Injectable()
export class ProductionPlanService {
  constructor(private readonly prisma: PrismaService) {}

  /** 4축 AND — 모순 조합은 빈 목록이다(400 아니다 · I-12 §9-1 #14 선례). */
  async list(query: ProductionPlanListQuery): Promise<PagedResponse<ProductionPlanView>> {
    const page = pageRequest(query);
    const where: Prisma.production_planWhereInput = {
      ...filter('production_order_id', query.productionOrderId),
      // `statusCode` 는 값 목록 검사를 하지 않는다(조회 전용 · P/O 목록 선례).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...planDateWhere(query.planDateFrom, query.planDateTo),
    };

    const [rows, total] = await Promise.all([
      this.prisma.production_plan.findMany({
        where,
        orderBy: [{ plan_date: 'asc' }, { production_plan_id: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.production_plan.count({ where }),
    ]);
    return pagedResponse(rows.map(productionPlanView), total, page);
  }

  /** 없으면 404 다(계약 선언). */
  async detail(productionPlanId: number): Promise<{ view: ProductionPlanView; versionNo: number }> {
    const row = await this.prisma.production_plan.findUnique({
      where: { production_plan_id: productionPlanId },
    });
    if (!row) throw new NotFoundException('없는 생산계획입니다.');
    return { view: productionPlanView(row), versionNo: row.version_no };
  }
}

/** `plan_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 그대로 비교한다(CLAUDE.md · ASN 선례). */
function planDateWhere(from?: string, to?: string): Prisma.production_planWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    plan_date: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}
