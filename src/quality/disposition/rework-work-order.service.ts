import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { Tx } from '../../core/lot';
import { WORK_ORDER_INITIAL_STATUS } from '../../core/work-order/defaults';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `ReworkWorkOrderIssue` — required 둘. */
export interface ReworkWorkOrderIssue {
  routingOperationId: number;
  orderQty: number;
  uomId?: number;
  plannedStartAt?: string;
  plannedEndAt?: string;
  remarks?: string;
}

/** 계약 `ReworkWorkOrder` — 발행 결과. `remainingQty` 는 **이 발행 뒤** 남은 잔량이다. */
export interface ReworkWorkOrderView {
  workOrderId: number;
  workOrderNo: string;
  workOrderTypeCode: string;
  statusCode: string;
  orderQty: number;
  uomId: number;
  routingOperationId: number;
  itemId: number;
  reworkSourceNonconformanceId: number;
  reworkSourceLotId: number | null;
  remainingQty: number;
}

const REWORK = 'REWORK';
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const INVALID_STATE = 'INVALID_STATE';
/** 계약 `QualityConflictResponse.code` 의 값 — 판정 저장의 잔량 초과와 같은 뜻이라 같은 코드를 쓴다. */
const QTY_EXCEEDED = 'DISPOSITION_QTY_EXCEEDED';
const WORK_ORDER = 'WORK_ORDER';

/** 이 부적합의 재작업 몫 — 판정 합과 이미 발행한 W/O 합. 잠금 «안»에서 한 번에 읽는다. */
interface ReworkScope {
  itemId: bigint;
  uomId: bigint;
  /** 원천 LOT — 여럿이면 첫 줄. 라벨·추적이 되짚을 자리라 비워 두지 않는다. */
  lotId: bigint | null;
  /** 원천 W/O — 생산계획을 여기서 승계한다. 없으면 발행할 계획이 없다. */
  productionPlanId: bigint | null;
  decidedQty: Prisma.Decimal;
  issuedQty: Prisma.Decimal;
}

/**
 * ⭐⭐ `POST /quality/nonconformances/{id}:issue-rework-work-order` — **재작업 W/O 발행**.
 *
 * ⛔ **판정만으로 자동 생성하지 않는다**(사용자 결정 2026-09-21 · omf-all-around#47). 판정은
 *    「이 부적합을 재작업으로 처리한다」까지이고, 수량·공정·시점은 담당자가 정해 발행한다.
 *    자동 생성하면 아직 정해지지 않은 수량·공정으로 지시가 현장에 나가고, 되돌리려면 취소
 *    지시가 또 필요하다.
 *
 * ⭐ **자리가 품질이다.** 발행 주체가 품질 담당(W-03-10)이고, 발행 수량의 상한이 처분 판정의
 *    잔량이라 그 계산이 사는 곳에서 잠그는 편이 맞다 — 부적합을 `FOR UPDATE` 로 잠근 «안»에서
 *    판정 합과 발행 합을 함께 읽는다. 생산 쪽 `POST /production/work-orders` 는 권한이
 *    `W-02-02`·`W-02-07` 이고 생산계획을 필수로 받아 이 흐름에 맞지 않는다.
 *
 * ⚠ **계약보다 앞선 경로다**(장부 P-33). 계약 사본에 우리가 먼저 적었고 지킴이 spec 이 그것을
 *   지킨다.
 */
@Injectable()
export class ReworkWorkOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * 201 + ETag(부적합의 **새** `version_no`) — 판정 저장과 같은 토큰이다.
   *
   * 갈래 순서: 존재(404) → 재작업 판정 없음(409 `INVALID_STATE`) → 단위 다름(400) → 잔량
   * 초과(409 `DISPOSITION_QTY_EXCEEDED`) → 공정 없음(400) → 판 번호(409 `VERSION_CONFLICT`).
   *
   * ⛔ **채번은 트랜잭션 «밖»이다** — 안에서 부르면 한 요청이 커넥션을 둘 쥔다(저장소 관례).
   *    실패하면 번호가 결번으로 남지만 계약이 번호의 연속을 요구하지 않는다.
   */
  async issue(
    nonconformanceId: number,
    version: number,
    body: ReworkWorkOrderIssue,
    appUserId: number,
  ): Promise<{ view: ReworkWorkOrderView; versionNo: number }> {
    const workOrderNo = await this.numbering.next(WORK_ORDER, null, today());

    return this.prisma.$transaction(async (tx) => {
      const id = BigInt(nonconformanceId);
      const locked = await lockNonconformance(tx, id);
      const scope = await readReworkScope(tx, id);

      /* ⛔ 재작업 판정이 없으면 발행할 근거가 없다 — 폐기·정상 판정만 있는 부적합이다. */
      if (scope.decidedQty.lessThanOrEqualTo(0)) {
        throw new ConflictException('user', '재작업으로 판정된 수량이 없습니다.', { code: INVALID_STATE });
      }

      /*
       * ⛔ **단위를 바꿔 받지 않는다.** 상한(판정 합 − 발행 합)은 «부적합의 단위» 기준인데 본문이
       *    다른 단위를 실으면 환산 없이 그 수만 비교해 「60 EA 판정」에 「40 BOX 재작업」이 선다.
       *    판정 저장이 같은 자리를 같은 규칙으로 막는다(`disposition-write.service.ts` ⓐ).
       *    계약이 칸을 남겨 둔 것은 «명시해도 된다»는 뜻이지 바꿔도 된다는 뜻이 아니다.
       */
      if (body.uomId !== undefined && BigInt(body.uomId) !== scope.uomId) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('uomId', ERROR_CODE.INVALID, '부적합의 단위와 같아야 합니다.'),
        ]);
      }

      const orderQty = new Prisma.Decimal(body.orderQty);
      const remaining = scope.decidedQty.minus(scope.issuedQty);
      /*
       * ⛔ **같은 부적합의 발행 누계를 넘지 않는다.** 물리 유니크가 없는 자리라 서버가 지킨다 —
       *    잠금 «안»에서 재계수하므로 동시 요청 둘이 같은 잔량을 보고 함께 통과하지 못한다.
       */
      if (orderQty.greaterThan(remaining)) {
        throw new ConflictException(
          'user',
          `재작업 판정 잔량(${remaining.toString()})을 넘는 수량은 발행할 수 없습니다.`,
          { code: QTY_EXCEEDED },
        );
      }

      /*
       * ⚠ 생산계획은 **원천 W/O 에서 승계한다.** 재작업은 계획을 새로 세우지 않고 원래 만들던
       *   그 계획의 뒷일이다. 원천 W/O 가 없는 부적합(입고 검사 등)은 승계할 계획이 없어 막는다 —
       *   긴급 발행처럼 계획을 서버가 지어내는 길은 공장 컨텍스트가 정해진 뒤다(문의 040).
       */
      if (scope.productionPlanId === null) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('nonconformanceId', ERROR_CODE.INVALID, '생산 작업지시에서 난 부적합이 아니라 재작업 지시를 발행할 수 없습니다.'),
        ]);
      }

      const operation = await tx.routing_operation.findUnique({
        where: { routing_operation_id: BigInt(body.routingOperationId) },
        select: { routing_operation_id: true },
      });
      /* 공정은 담당자가 고른다 — 원천 라우팅으로 좁히지 않는다(수리 공정이 따로 있다). 있기만 하면 된다. */
      if (operation === null) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('routingOperationId', ERROR_CODE.INVALID, '없는 공정입니다.'),
        ]);
      }

      const created = await tx.work_order.create({
        data: {
          work_order_no: workOrderNo,
          production_plan_id: scope.productionPlanId,
          routing_operation_id: BigInt(body.routingOperationId),
          item_id: scope.itemId,
          order_qty: orderQty,
          /* 부적합의 단위로 고정된다 — 본문이 다른 값을 실으면 위에서 이미 400 이다. */
          uom_id: scope.uomId,
          work_order_type_code: REWORK,
          status_code: WORK_ORDER_INITIAL_STATUS,
          /* ⭐ 이 셋이 P-04-03 이 대상을 찾는 축이다 — 비우면 화면이 원천 수량과 대조하지 못한다. */
          rework_source_nonconformance_id: id,
          rework_source_lot_id: scope.lotId,
          planned_start_at: body.plannedStartAt === undefined ? null : new Date(body.plannedStartAt),
          planned_end_at: body.plannedEndAt === undefined ? null : new Date(body.plannedEndAt),
          remarks: body.remarks ?? null,
          created_by: BigInt(appUserId),
        },
        select: {
          work_order_id: true,
          work_order_no: true,
          work_order_type_code: true,
          status_code: true,
          order_qty: true,
          uom_id: true,
          routing_operation_id: true,
          item_id: true,
        },
      });

      /*
       * ⭐ 부적합의 판 번호를 올린다 — 발행이 그 부적합의 «남은 재작업»을 바꾸므로, 같은 화면을
       *   보던 다른 사람의 토큰은 낡은 것이 되어야 한다(판정 저장과 같은 규율).
       */
      const updated = await tx.nonconformance.updateMany({
        where: { nonconformance_id: id, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: BigInt(appUserId), updated_at: new Date() },
      });
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(locked.version_no) });

      return {
        view: {
          workOrderId: Number(created.work_order_id),
          workOrderNo: created.work_order_no,
          workOrderTypeCode: created.work_order_type_code,
          statusCode: created.status_code,
          orderQty: created.order_qty.toNumber(),
          uomId: Number(created.uom_id),
          routingOperationId: Number(created.routing_operation_id),
          itemId: Number(created.item_id),
          reworkSourceNonconformanceId: nonconformanceId,
          reworkSourceLotId: scope.lotId === null ? null : Number(scope.lotId),
          remainingQty: remaining.minus(orderQty).toNumber(),
        },
        versionNo: locked.version_no + 1,
      };
    });
  }
}

/** 판정 저장과 같은 잠금 — 잔량을 읽기 «전»에 건다. */
async function lockNonconformance(tx: Tx, id: bigint): Promise<{ version_no: number }> {
  const rows = await tx.$queryRaw<{ version_no: number }[]>`
    SELECT version_no FROM quality.nonconformance WHERE nonconformance_id = ${id} FOR UPDATE`;
  const [row] = rows;
  if (row === undefined) throw new NotFoundException('부적합을 찾을 수 없습니다.');
  return row;
}

/** 재작업 판정 합·발행 합·승계할 계획을 **잠금 안에서 한 번에** 읽는다. */
async function readReworkScope(tx: Tx, id: bigint): Promise<ReworkScope> {
  const nc = await tx.nonconformance.findUniqueOrThrow({
    where: { nonconformance_id: id },
    select: {
      item_id: true,
      item: { select: { base_uom_id: true } },
      /* 관계 이름이 길다 — 부적합이 난 W/O 로 가는 쪽이다(재작업으로 «나온» W/O 는 반대편 관계). */
      work_order_nonconformance_work_order_idTowork_order: { select: { production_plan_id: true } },
      nonconformance_lot: {
        orderBy: { nonconformance_lot_id: 'asc' },
        select: { lot_id: true, uom_id: true },
      },
      disposition_decision: {
        where: { disposition_type_code: REWORK },
        select: { decision_qty: true },
      },
    },
  });
  const issued = await tx.work_order.aggregate({
    where: { rework_source_nonconformance_id: id },
    _sum: { order_qty: true },
  });
  const lots = nc.nonconformance_lot;

  return {
    itemId: nc.item_id,
    uomId: lots.length > 0 ? lots[0].uom_id : nc.item.base_uom_id,
    lotId: lots.length > 0 ? lots[0].lot_id : null,
    productionPlanId:
      nc.work_order_nonconformance_work_order_idTowork_order?.production_plan_id ?? null,
    decidedQty: nc.disposition_decision.reduce(
      (sum: Prisma.Decimal, row: { decision_qty: Prisma.Decimal }) => sum.add(row.decision_qty),
      new Prisma.Decimal(0),
    ),
    issuedQty: issued._sum.order_qty ?? new Prisma.Decimal(0),
  };
}

/** 채번 기간 키 — 본문에 날짜 칸이 없어 서버 날짜를 쓴다(W/O 발행과 같다). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
