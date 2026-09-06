import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotRegistryService, nextMesLotNos, slotQtys, Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BomComponentRow,
  ISSUE_REQUESTED,
  MaterialIssueLine,
  materialRequirements,
  skipsMaterialIssue,
} from './material-issue';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

/** 계약 `WorkOrderRelease` — required 는 `lotSize` 하나이고 서버 기본값이 없다(R-17). */
export interface WorkOrderRelease {
  lotSize: number;
  /** ⚠ 받되 **저장하지 않는다** — 담을 칸이 없고 `remarks` 에 덧붙이지도 않는다(§4-5). */
  handoverNote?: string;
}

const STATUS_COLUMN = 'production.work_order.status_code';
const RELEASE_ACTION = 'work-order-release';
const MATERIAL_ISSUE_REQUEST = 'MATERIAL_ISSUE_REQUEST';

/** 배포가 읽는 W/O — 공장은 계획을 거쳐 «한 축»으로만 푼다(R-7). */
const RELEASE_SELECT = {
  order_qty: true,
  item_id: true,
  uom_id: true,
  routing_operation_id: true,
  work_order_type_code: true,
  default_wip_location_id: true,
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

/**
 * 확정·배포 + 생산LOT 선발행 + 자재 출고요청 자동 발행 — 계약이 ⌜한 트랜잭션⌝ 이라 적었다.
 * 순서는 §4-1 그대로다: 검증·채번은 트랜잭션 «밖», 상태·슬롯·요청은 «안».
 */
@Injectable()
export class WorkOrderReleaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly numbering: NumberingService,
    private readonly lots: LotRegistryService,
  ) {}

  async release(
    workOrderId: number,
    version: number,
    body: WorkOrderRelease,
    appUserId: number,
  ): Promise<void> {
    const row = await this.load(workOrderId);
    const plan = this.plan(row);
    // 채번보다 «앞»이다 — `lotSize ≤ 0` 이면 여기서 400 이 나고 번호를 뽑지 않는다.
    const qtys = slotQtys(row.order_qty, new Prisma.Decimal(body.lotSize));

    const components = await this.components(row, plan.bom_id);
    const businessDate = today();
    const plantId = plan.production_order.plant_id;
    // ⛔ `$transaction` 을 열기 «전»에 부른다 — 안에서 부르면 커넥션을 둘 쥔다.
    //    실패하면 번호가 결번으로 남는데 허용한다(계약이 연속을 요구하지 않는다).
    const issueRequestNo =
      components.length === 0
        ? null
        : await this.numbering.next(MATERIAL_ISSUE_REQUEST, plantId, businessDate);

    await this.prisma.$transaction(async (tx) => {
      const locked = await lockWorkOrder(tx, workOrderId);
      // ⭐ 버전 대조가 전이 검사보다 «먼저»다(`document-cancel.service.ts` 선례).
      assertVersion(locked, version);
      // ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(§1-6).
      const transition = this.documentState.assertTransition(
        STATUS_COLUMN,
        RELEASE_ACTION,
        locked.status_code,
        HttpStatus.BAD_REQUEST,
      );

      await tx.work_order.update({
        where: { work_order_id: BigInt(workOrderId) },
        data: {
          status_code: transition.to,
          released_at: new Date(),
          version_no: { increment: 1 },
          updated_by: appUserId,
          operation_settings_snapshot: operationSettings(row.routing_operation),
        },
      });

      const lotNos = await nextMesLotNos(tx, Number(plantId), businessDate, qtys.length);
      await this.lots.preIssueWithin(
        tx,
        {
          workOrderId: BigInt(workOrderId),
          plantId: Number(plantId),
          itemId: Number(row.item_id),
          uomId: Number(row.uom_id),
          bomId: Number(plan.bom_id),
          bomVersion: plan.bom.bom_version,
          lotNos,
          qtys,
        },
        appUserId,
      );

      if (issueRequestNo !== null && row.default_wip_location_id !== null) {
        await this.issueRequest(tx, {
          workOrderId,
          issueRequestNo,
          destinationLocationId: row.default_wip_location_id,
          lines: materialRequirements(components, row.order_qty, plan.bom.base_qty),
          appUserId,
        });
      }
    });
  }

  private async load(workOrderId: number): Promise<ReleaseRow> {
    const row = await this.prisma.work_order.findUnique({
      where: { work_order_id: workOrderId },
      select: RELEASE_SELECT,
    });
    if (row === null) throw new NotFoundException('없는 작업지시입니다.');
    return row;
  }

  /** R-6 이 계획 없는 발행을 막았으나 그 전에 생긴 행이 남아 있을 수 있어 400 으로 가른다. */
  private plan(row: ReleaseRow): NonNullable<ReleaseRow['production_plan']> {
    if (row.production_plan === null) {
      throw one(
        field('productionPlanId', ERROR_CODE.REQUIRED, '공장을 풀 계획이 없습니다(문의 040).'),
      );
    }
    return row.production_plan;
  }

  /**
   * 담을 BOM 라인 — **이 공정의 것만**이다. ⛔ `routing_operation_id IS NULL` 은 담지
   * 않는다(「공정 미지정 = 전 공정 공통」은 우리가 지어내는 뜻이다). 전건을 담으면 같은
   * 계획의 공정 W/O 여럿이 같은 자재를 겹쳐 요청한다.
   * ⚠ 도착 위치를 못 풀면 아예 안 담는다 — 요청 «없이» 배포는 성공한다(400 이 아니다).
   */
  private components(row: ReleaseRow, bomId: bigint): Promise<BomComponentRow[]> {
    if (skipsMaterialIssue(row.work_order_type_code) || row.default_wip_location_id === null) {
      return Promise.resolve([]);
    }
    return this.prisma.bom_component.findMany({
      where: { bom_id: bomId, routing_operation_id: row.routing_operation_id },
      select: { bom_component_id: true, component_item_id: true, uom_id: true, required_qty: true },
      orderBy: { sequence_no: 'asc' },
    });
  }

  private async issueRequest(
    tx: Tx,
    input: {
      workOrderId: number;
      issueRequestNo: string;
      destinationLocationId: bigint;
      lines: MaterialIssueLine[];
      appUserId: number;
    },
  ): Promise<void> {
    const header = await tx.material_issue_request.create({
      data: {
        issue_request_no: input.issueRequestNo,
        work_order_id: BigInt(input.workOrderId),
        destination_location_id: input.destinationLocationId,
        status_code: ISSUE_REQUESTED,
        requested_by: input.appUserId,
        created_by: input.appUserId,
        // `required_at`·`reason_code` 는 비운다 — 받는 칸이 없고, 사유 4값에 「BOM 자동
        // 발행」이 없어 값을 지어내지 않는다(둘 다 nullable).
      },
      select: { material_issue_request_id: true },
    });
    await tx.material_issue_request_line.createMany({
      data: input.lines.map((line) => ({
        ...line,
        material_issue_request_id: header.material_issue_request_id,
      })),
    });
  }
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
