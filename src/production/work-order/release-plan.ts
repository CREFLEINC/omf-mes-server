import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { weeklyWorkingDays } from '../../app/policy/working-days';
import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { issueWorkDate } from '../../core/calendar/issue-work-date';
import { slotQtys } from '../../core/lot';
import { resolveCandidates, usesProductionWarehouses } from '../../core/material-issue/source-warehouse';
import { NumberingService } from '../../core/numbering';
import { localDate } from '../../planning/production-plan/plan-window';
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
  responsible_worker_id: true,
  // 배포 자체는 라인을 안 쓴다 — 현장 단말의 권한 검사가 «라인의 공장»으로 판정하므로
  // 라인이 비었거나 다른 공장이면 배포 뒤 전부 거부된다(omf-all-around#36). 여기서 막는다.
  production_line_id: true,
  production_line: { select: { plant_id: true } },
  planned_start_at: true,
  routing_operation: {
    select: {
      standard_cycle_time_sec: true,
      standard_yield_rate: true,
      /* PQC 는 라우팅이 「검사 공정」이라 명시한 공정에만 붙는다(설계 REQ-OA-0003 · opt-in). */
      inspection_managed: true,
      process_id: true,
      routing_id: true,
    },
  },
  production_plan: {
    select: {
      bom_id: true,
      bom: { select: { bom_version: true, base_qty: true } },
      production_order: { select: { plant_id: true, plant: { select: { timezone_code: true } } } },
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
  /** 생산 창고를 쓰는 공장(피처 003)이면 채운다. 비었으면 이 기능 전 경로 그대로다(FR-009a). */
  waiting: WaitingPlan | null;
}

/** 출발 창고별 대기 요청을 만드는 데 필요한 값 — 채번까지 트랜잭션 밖에서 끝낸다. */
export interface WaitingPlan {
  plantId: bigint;
  productionLineId: bigint;
  /** 부서 생산 창고 D(W/O 공장의 활성 창고). */
  warehouseIds: bigint[];
  /** 라인의 생산 현장. */
  destinationLocationId: bigint;
  /** 생산일(공장 현지 `planned_start_at` 날짜)의 직전 근무일. 만들 때 한 번 계산한다(FR-033). */
  issueWorkDate: string;
  /** 출고 작업일이 공장 오늘 이하 — 같은 트랜잭션에서 배포한다(FR-003). */
  releaseNow: boolean;
  /** 요청은 창고마다 한 장 — 고를 수 있는 창고 수(|D|)만큼 미리 받는다. 안 쓴 번호는 결번이다. */
  issueRequestNos: string[];
  /** 즉시 배포면 요청마다 피킹 지시 한 장 — 역시 |D| 만큼. */
  pickingOrderNos: string[];
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
  if (row === null) throw new NotFoundException('없는 MES W/O 입니다.');

  const plan = row.production_plan;
  // R-6 이 계획 없는 발행을 막았으나 그 전에 생긴 행이 남아 있을 수 있어 400 으로 가른다.
  if (plan === null) {
    throw one(
      field('productionPlanId', ERROR_CODE.REQUIRED, '공장을 풀 계획이 없습니다(문의 040).'),
    );
  }

  // ⛔ 이 검사와 `lineErrors` 를 바꾸면 `production-order-worklist.ts` 의 조각도 함께 고친다 — 갈리면 ERP W/O 목록에는 「배포 대기」로 보이는데 배포가 막힌다.
  const missingLocations = [
    ['defaultWipLocationId', row.default_wip_location_id],
    ['defaultFgLocationId', row.default_fg_location_id],
    ['defaultScrapLocationId', row.default_scrap_location_id],
  ] as const;
  const locationErrors = missingLocations
    .filter(([, value]) => value === null)
    .map(([name]) => field(name, ERROR_CODE.REQUIRED, '배포 전에 기본 위치를 지정해야 합니다.'));
  const preconditionErrors = [...locationErrors, ...lineErrors(row, plan)];
  if (preconditionErrors.length > 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, preconditionErrors);
  }

  // 채번보다 «앞»이다 — `lotSize ≤ 0` 이면 여기서 400 이 나고 번호를 안 뽑는다.
  const qtys = slotQtys(row.order_qty, new Prisma.Decimal(lotSize));
  const components = await bomComponents(prisma, row, plan.bom_id);
  const businessDate = today();
  const plantId = plan.production_order.plant_id;
  const waiting =
    components.length > 0 && row.production_line_id !== null && (await usesProductionWarehouses(prisma, plantId))
      ? await waitingPlan(prisma, numbering, { row, plantId, productionLineId: row.production_line_id, businessDate })
      : null;

  return {
    row,
    plan,
    qtys,
    businessDate,
    components,
    waiting,
    issueRequestNo:
      components.length === 0 || waiting !== null
        ? null
        : await numbering.next(
            'MATERIAL_ISSUE_REQUEST',
            plan.production_order.plant_id,
            businessDate,
          ),
  };
}

/**
 * 생산 창고 공장의 대기 요청 준비(피처 003 · research R-5·R-7). 빠진 기준정보(라인 부서 · 부서 생산 창고 · 라인
 * 생산 현장)는 모아 400 이다(FR-009) — 재고 부족은 배포를 막지 않는다. 창고 고르기는 재고에 기대므로 트랜잭션 안이다.
 */
async function waitingPlan(
  prisma: PrismaService,
  numbering: NumberingService,
  input: { row: ReleaseRow; plantId: bigint; productionLineId: bigint; businessDate: string },
): Promise<WaitingPlan> {
  const scope = await resolveCandidates(prisma, { plantId: input.plantId, productionLineId: input.productionLineId });
  if ('errors' in scope) throw new ContractException(HttpStatus.BAD_REQUEST, scope.errors);

  const timezone = input.row.production_plan?.production_order.plant.timezone_code ?? 'UTC';
  const plantToday = localDate(new Date(), timezone);
  // 계획 시작 시각이 없으면 생산일을 알 수 없다 — 오늘로 보아 바로 배포한다(지금 방식과 같은 결과).
  const productionDate =
    input.row.planned_start_at === null ? plantToday : localDate(input.row.planned_start_at, timezone);
  const workDate = issueWorkDate(productionDate, await weeklyWorkingDays(prisma, input.plantId, plantToday));
  const releaseNow = workDate <= plantToday;
  const count = scope.warehouseIds.length;
  return {
    ...scope,
    plantId: input.plantId,
    productionLineId: input.productionLineId,
    issueWorkDate: workDate,
    releaseNow,
    issueRequestNos: await numbering.nextMany('MATERIAL_ISSUE_REQUEST', input.plantId, input.businessDate, count),
    pickingOrderNos: releaseNow
      ? await numbering.nextMany('PICKING_ORDER', input.plantId, input.businessDate, count)
      : [],
  };
}

/**
 * 배포 전 생산라인 검사(omf-all-around#36 · 사용자 2026-09-19). 배포·출고는 계획의 공장
 * 한 축으로 돌지만(R-7) 단말 권한 검사는 `work_order.production_line.plant_id` 로 판정한다.
 * 두 길이 갈리면 관리웹에서는 배포·출고까지 되고 현장 단말에서만 전부 막힌다 — 배포에서 막는다.
 * ⛔ 단말 권한 검사 쪽 기준은 바꾸지 않는다. 라인이 없는 배포 전 W/O 를 단말 목록이 어느 공장으로 보는지는
 *   `work-order-query.service.ts` 의 `terminalPlantWhere` 다.
 */
function lineErrors(row: ReleaseRow, plan: NonNullable<ReleaseRow['production_plan']>) {
  if (row.production_line_id === null || row.production_line === null) {
    return [
      field('productionLineId', ERROR_CODE.REQUIRED, '배포 전에 생산라인을 지정해야 합니다.'),
    ];
  }
  if (row.production_line.plant_id !== plan.production_order.plant_id) {
    return [
      field(
        'productionLineId',
        ERROR_CODE.INVALID,
        '생산라인의 공장이 MES W/O 공장과 다릅니다.',
      ),
    ];
  }
  return [];
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
    // 소요량 0 인 구성품은 꺼낼 것이 없다 — ERP BOM 에 720행 있다. 담으면 출고요청 라인의
    // `requested_qty > 0` 에 걸리고, 전부 0 이면 라인 없는 헤더가 선다.
    where: {
      bom_id: bomId,
      routing_operation_id: row.routing_operation_id,
      required_qty: { gt: 0 },
    },
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
