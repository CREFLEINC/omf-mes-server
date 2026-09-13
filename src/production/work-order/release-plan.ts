import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { slotQtys } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { BOM_COMPONENT_SELECT, BomComponentRow, skipsMaterialIssue } from './material-issue';

/** 배포가 읽는 W/O — 공장은 계획을 거쳐 «한 축»으로만 푼다(R-7). */
const RELEASE_SELECT = {
  order_qty: true,
  item_id: true,
  uom_id: true,
  routing_operation_id: true,
  work_order_type_code: true,
  default_wip_location_id: true,
  default_fg_location_id: true,
  default_scrap_location_id: true,
  routing_operation: { select: { standard_cycle_time_sec: true, standard_yield_rate: true } },
  production_plan: {
    select: {
      bom_id: true,
      bom: { select: { bom_version: true, base_qty: true } },
      production_order: { select: { plant_id: true } },
    },
  },
} satisfies Prisma.work_orderSelect;

type ReleaseRow = Prisma.work_orderGetPayload<{ select: typeof RELEASE_SELECT }>;

/** `$transaction` 을 열기 전에 다 정해 두는 값들 — 트랜잭션 안은 쓰기만 한다. */
export interface ReleasePlan {
  row: ReleaseRow;
  /** 공장·BOM 스냅샷의 단일 출처(R-7) — 400 을 먼저 걸러 non-null 로 좁혀 둔다. */
  plan: NonNullable<ReleaseRow['production_plan']>;
  /** 슬롯 N 개의 계획 수량 — 합이 지시수량과 정확히 같다. */
  qtys: Prisma.Decimal[];
  businessDate: string;
  components: BomComponentRow[];
  /** 담을 라인이 0건이면 뽑지 않는다 — 그때는 헤더도 만들지 않는다. */
  issueRequestNo: string | null;
}

/**
 * §4-1 의 ②③④ — 검증·읽기·도출·채번. ⛔ 전부 `$transaction` **밖**이다.
 * 채번을 트랜잭션 안에서 부르면 한 요청이 커넥션을 둘 쥔다. 실패하면 번호가 결번으로
 * 남는데 허용한다 — 계약이 번호의 연속을 요구하지 않는다.
 */
export async function releasePlan(
  prisma: PrismaService,
  numbering: NumberingService,
  workOrderId: number,
  lotSize: number,
): Promise<ReleasePlan> {
  const row = await prisma.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: RELEASE_SELECT,
  });
  if (row === null) throw new NotFoundException('없는 작업지시입니다.');

  const plan = row.production_plan;
  // R-6 이 계획 없는 발행을 막았으나 그 전에 생긴 행이 남아 있을 수 있어 400 으로 가른다.
  if (plan === null) {
    throw one(
      field('productionPlanId', ERROR_CODE.REQUIRED, '공장을 풀 계획이 없습니다(문의 040).'),
    );
  }

  const missingLocations = [
    ['defaultWipLocationId', row.default_wip_location_id],
    ['defaultFgLocationId', row.default_fg_location_id],
    ['defaultScrapLocationId', row.default_scrap_location_id],
  ] as const;
  const locationErrors = missingLocations
    .filter(([, value]) => value === null)
    .map(([name]) => field(name, ERROR_CODE.REQUIRED, '배포 전에 기본 위치를 지정해야 합니다.'));
  if (locationErrors.length > 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, locationErrors);
  }

  // 채번보다 «앞»이다 — `lotSize ≤ 0` 이면 여기서 400 이 나고 번호를 안 뽑는다.
  const qtys = slotQtys(row.order_qty, new Prisma.Decimal(lotSize));
  const components = await bomComponents(prisma, row, plan.bom_id);
  const businessDate = today();

  return {
    row,
    plan,
    qtys,
    businessDate,
    components,
    issueRequestNo:
      components.length === 0
        ? null
        : await numbering.next(
            'MATERIAL_ISSUE_REQUEST',
            plan.production_order.plant_id,
            businessDate,
          ),
  };
}

/**
 * 담을 BOM 라인 — **이 공정의 것만**이다. ⛔ `routing_operation_id IS NULL` 은 담지
 * 않는다(「공정 미지정 = 전 공정 공통」은 우리가 지어내는 뜻이다). 전건을 담으면 같은
 * 계획의 공정 W/O 여럿이 같은 자재를 겹쳐 요청한다.
 */
function bomComponents(
  prisma: PrismaService,
  row: ReleaseRow,
  bomId: bigint,
): Promise<BomComponentRow[]> {
  if (skipsMaterialIssue(row.work_order_type_code)) {
    return Promise.resolve([]);
  }
  return prisma.bom_component.findMany({
    where: { bom_id: bomId, routing_operation_id: row.routing_operation_id },
    select: BOM_COMPONENT_SELECT,
    orderBy: { sequence_no: 'asc' },
  });
}

/**
 * R-27 — 확정 시점의 공정 설정. 계약 example 이 든 **두 키만** 굳힌다: NULL 이면 키를
 * 생략하고 둘 다 NULL 이면 `{}` 다. 더 넣지 않는다(계약이 적은 밖은 지어내는 것).
 */
export function operationSettings(operation: {
  standard_cycle_time_sec: Prisma.Decimal | null;
  standard_yield_rate: Prisma.Decimal | null;
}): Prisma.JsonObject {
  const cycle = operation.standard_cycle_time_sec;
  const yieldRate = operation.standard_yield_rate;
  return {
    ...(cycle === null ? {} : { standardCycleTimeSec: cycle.toNumber() }),
    ...(yieldRate === null ? {} : { standardYieldRate: yieldRate.toNumber() }),
  };
}

/** 채번 기간 키 — `:release` 본문에 날짜 칸이 없다. 서버·컨테이너 TZ 가 UTC 로 고정이다. */
const today = (): string => new Date().toISOString().slice(0, 10);
