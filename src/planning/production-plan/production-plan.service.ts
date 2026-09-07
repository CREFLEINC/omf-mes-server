import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues, filter, optional, optionalDate } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionPlanView, productionPlanView } from './production-plan-view';

/** 조회 2 + CRUD 3(PR ①a·②) — `:confirm` 은 PR ③ 몫이다. */
export interface ProductionPlanListQuery {
  productionOrderId?: number;
  statusCode?: string;
  planDateFrom?: string;
  planDateTo?: string;
  page?: number;
  size?: number;
}

/** 계약 `ProductionPlanSplitRef` — 러닝체인지 분할 원본. */
export interface ProductionPlanSplitRef {
  sourcePlanId?: number;
  reasonCode?: string;
}

/** 계약 `ProductionPlanCreate` — required 6. */
export interface ProductionPlanCreate {
  productionOrderId: number;
  planDate: string;
  plannedQty: number;
  uomId: number;
  bomId: number;
  routingId: number;
  plannedLineId?: number;
  splitOfPlanId?: ProductionPlanSplitRef;
  remarks?: string;
}

/** 계약 `ProductionPlanUpdate` — required 0. 뒤 둘만 명시적 null = 해제. */
export interface ProductionPlanUpdate {
  planDate?: string;
  plannedQty?: number;
  bomId?: number;
  routingId?: number;
  plannedLineId?: number | null;
  remarks?: string | null;
}

/** 태어나는 상태 · 확정 뒤 잠기는 상태. */
const DRAFT = 'DRAFT';
/** 채번 문서 유형 — `DEFAULT_PREFIX` 의 `PP`. */
const PRODUCTION_PLAN = 'PRODUCTION_PLAN';
/** `plan_no` 채번 재시도 상한(I-2 R-2 · `goods-receipt.service.ts` 선례). */
const NUMBER_RETRY = 3;
/** `ProductionConflictResponse.code`(required) — 이 파일 전용, `ERROR_CODE` 표에 더하지 않는다. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const INVALID_STATE = 'INVALID_STATE';
const DUPLICATE_KEY = 'DUPLICATE_KEY';

/** 잠근 계획에서 판정에 쓰는 칸만. */
interface LockedPlan {
  status_code: string;
  version_no: number;
}

@Injectable()
export class ProductionPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

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

  /**
   * POST — 201. 채번은 `$transaction` «밖»(I-24 §3-5 · §4-1). ⛔ 합계 검증·원본 수량
   * 조정 없음 — `W-02-02` §5-2·§5-7 이 그 둘을 화면 책임으로 못 박았다.
   */
  async create(body: ProductionPlanCreate, appUserId: number | undefined): Promise<ProductionPlanView> {
    await assertCodeValues(this.prisma, [
      {
        field: 'splitOfPlanId.reasonCode',
        value: body.splitOfPlanId?.reasonCode,
        groupCode: 'PRODUCTION_PLAN_SPLIT_REASON',
      },
    ]);
    if (body.plannedQty <= 0) {
      throw one(field('plannedQty', ERROR_CODE.INVALID, '0보다 커야 합니다.'));
    }
    // ⛔ 404 가 아니다(계약 미선언) — 없는 P/O 는 필드 오류로 낸다.
    const order = await this.prisma.production_order.findUnique({
      where: { production_order_id: BigInt(body.productionOrderId) },
      select: { plant_id: true },
    });
    if (!order) {
      throw one(field('productionOrderId', ERROR_CODE.INVALID, '없는 생산오더입니다.'));
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const planNo = await this.numbering.next(PRODUCTION_PLAN, order.plant_id, body.planDate);
        const created = await this.prisma.production_plan.create({
          data: {
            production_order_id: BigInt(body.productionOrderId),
            plan_no: planNo,
            plan_date: new Date(`${body.planDate}T00:00:00.000Z`),
            planned_qty: body.plannedQty,
            uom_id: BigInt(body.uomId),
            bom_id: BigInt(body.bomId),
            routing_id: BigInt(body.routingId),
            planned_line_id: idOf(body.plannedLineId),
            status_code: DRAFT,
            ...(body.splitOfPlanId?.sourcePlanId === undefined
              ? {}
              : { split_of_plan_id: BigInt(body.splitOfPlanId.sourcePlanId) }),
            ...(body.splitOfPlanId?.reasonCode === undefined
              ? {}
              : { split_reason_code: body.splitOfPlanId.reasonCode }),
            remarks: body.remarks ?? null,
            created_by: appUserId ?? null,
            updated_by: appUserId ?? null,
          },
        });
        return productionPlanView(created);
      } catch (error) {
        if (!isDuplicatePlanNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '계획번호를 매기지 못했습니다. 다시 시도해 주세요.', {
            code: DUPLICATE_KEY,
          });
        }
      }
    }
  }

  /** PUT — 200. 잠금 → 토큰 → 상태 순(I-12 R-6 과 같은 순서 · I-24 §4-2). */
  async update(
    productionPlanId: number,
    version: number,
    body: ProductionPlanUpdate,
    appUserId: number | undefined,
  ): Promise<ProductionPlanView> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockPlan(tx, productionPlanId);
      assertPlanVersion(locked, version);
      if (locked.status_code !== DRAFT) {
        throw one(field('statusCode', ERROR_CODE.STATE_LOCKED, '확정된 계획은 고칠 수 없습니다.'));
      }
      const updated = await tx.production_plan.update({
        where: { production_plan_id: BigInt(productionPlanId) },
        data: {
          ...optionalDate('plan_date', body.planDate),
          ...optional('planned_qty', body.plannedQty),
          ...optional('bom_id', idOf(body.bomId)),
          ...optional('routing_id', idOf(body.routingId)),
          ...optional('planned_line_id', idOf(body.plannedLineId)),
          ...optional('remarks', body.remarks),
          updated_by: appUserId ?? null,
          version_no: { increment: 1 },
        },
      });
      return productionPlanView(updated);
    });
  }

  /**
   * DELETE — 204 물리 삭제(계약 x-internal-note — 확정 전 계획은 초안이다). R-8(§0):
   * 자식 분할 계획이 있어도 `SUCCESSOR_EXISTS` 가 아니라 409 `INVALID_STATE` 다 —
   * `ProductionConflictResponse.code` enum 에 그 값이 없다.
   */
  async remove(productionPlanId: number, version: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockPlan(tx, productionPlanId);
      assertPlanVersion(locked, version);
      if (locked.status_code !== DRAFT) {
        throw new ConflictException('user', '확정된 계획은 지울 수 없습니다.', { code: INVALID_STATE });
      }
      // A11 자기 FK 를 손으로 먼저 본다 — 그대로 지우면 P2003 이 400 으로 새는데
      // 계약 DELETE 에 400 이 없다(§4-3).
      const children = await tx.production_plan.count({
        where: { split_of_plan_id: BigInt(productionPlanId) },
      });
      if (children > 0) {
        throw new ConflictException('user', '분할 계획이 매달려 있습니다.', { code: INVALID_STATE });
      }
      await tx.production_plan.delete({ where: { production_plan_id: BigInt(productionPlanId) } });
    });
  }
}

/** ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이 재확정이 끼는 것을 막는다. */
async function lockPlan(tx: Prisma.TransactionClient, productionPlanId: number): Promise<LockedPlan> {
  const rows = await tx.$queryRaw<LockedPlan[]>`
    SELECT status_code, version_no
      FROM planning.production_plan
     WHERE production_plan_id = ${BigInt(productionPlanId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 생산계획입니다.');
  return rows[0];
}

function assertPlanVersion(locked: LockedPlan, version: number): void {
  if (locked.version_no !== version) {
    assertUpdated(0, 'user', { code: VERSION_CONFLICT });
  }
}

function isDuplicatePlanNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.includes('plan_no');
}

const idOf = (value: number | null | undefined): bigint | null | undefined =>
  value === undefined || value === null ? (value as null | undefined) : BigInt(value);

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
