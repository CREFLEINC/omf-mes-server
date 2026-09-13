import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertWorkerNoPresent } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { InventoryPostingService } from '../../core/inventory-posting';
// ⛔ `index.ts` 가 재수출하지 않는다 — 코어는 PR ① 로 닫혔고 이 PR 은 코어 파일을 안 고친다.
import { lockBalancesInOrder } from '../../core/inventory-posting/balance-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { PickingQueryService } from './picking-query.service';
import { PickingLineView } from './picking-view';

/** 계약 `PickingLinePick` — required 3 · 선택 `lotId`. */
export interface PickingLinePick {
  pickedQty: number;
  lotId?: number | null;
  businessDate: string;
  occurredAt: string;
}

export type PickContext = {
  /** ⚠ 저장하지 않는다 — 담을 칸이 두 표에 없다(§6-7). */
  workerNo?: string;
  /** **선택**이다 — 없으면 대조하지 않는다(계약 `IfMatchVersionOptional`). */
  version?: number;
} & ({ actor: LogisticsWriteActor; appUserId?: never } | { appUserId: number; actor?: never });

/** ①의 `FOR UPDATE` 가 내리는 것 — 라인 축 + 지시의 창고(잔액 차원의 조직 3칸이 거기서 난다). */
interface LineRow {
  picking_line_id: bigint;
  item_id: bigint;
  lot_id: bigint;
  location_id: bigint;
  planned_qty: Prisma.Decimal;
  picked_qty: Prisma.Decimal;
  inventory_reservation_id: bigint | null;
  version_no: number;
  warehouse_id: bigint;
}

/** 등록만 된 출고는 라인을 안 잠근다 — 전기 전에 `picking_line_id` 가 이미 저장된다(R-14). */
const REGISTERED = 'REGISTERED';

/**
 * 라인 피킹 — `picked_qty` 를 **대체**하고 그 차이만큼 잔액의 `picked` 를 옮긴다(I-8.md §6).
 * ⛔ `status_code` 도 헤더 상태도 안 옮긴다 — 계약 `x-no-code-key` 가 「라인 진행은
 * `plannedQty ↔ pickedQty` 가 담는다」라 적었고 `picking_order` 4값에 「완료」가 없다(§6-6).
 * ⛔ 예약을 «걸지» 않는다 — 거는 오퍼레이션이 계약에 0건이다(문의 045).
 */
@Injectable()
export class PickingPickService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly queries: PickingQueryService,
  ) {}

  async pick(
    pickingOrderId: number,
    pickingLineId: number,
    body: PickingLinePick,
    context: PickContext,
  ): Promise<PickingLineView> {
    assertWorkerNoPresent(context.workerNo);
    assertMoments(body);

    await this.prisma.$transaction(async (tx) => {
      // ① 라인만 잠근다(`OF l`) — 지시까지 잡으면 같은 지시의 두 라인이 서로를 막는다.
      const [line] = await tx.$queryRaw<LineRow[]>`
        SELECT l.picking_line_id, l.item_id, l.lot_id, l.location_id, l.planned_qty,
               l.picked_qty, l.inventory_reservation_id, l.version_no, o.warehouse_id
          FROM logistics.picking_line l
          JOIN logistics.picking_order o ON o.picking_order_id = l.picking_order_id
         WHERE l.picking_line_id = ${pickingLineId}
           AND l.picking_order_id = ${pickingOrderId}
           FOR UPDATE OF l`;
      // 두 id 가 안 맞아도 404 다 — 남의 지시의 라인을 열지 않는다(§6-1 ①).
      if (line === undefined) throw new NotFoundException('없는 피킹 라인입니다.');
      // ② 업무 검사보다 «먼저» 본다(`document-cancel.service.ts:75-78` 선례).
      if (context.version !== undefined && line.version_no !== context.version) assertUpdated(0);

      await assertNotIssued(tx, pickingLineId);
      const pickedQty = new Prisma.Decimal(body.pickedQty);
      assertQty(pickedQty, line, body.lotId);
      await assertPickable(tx, line.lot_id);

      // ⑥ 대체 규약의 «차이»만 옮긴다(§6-4).
      const delta = pickedQty.minus(line.picked_qty);
      if (!delta.isZero()) await this.move(tx, line, delta);

      await tx.picking_line.update({
        where: { picking_line_id: line.picking_line_id },
        data: {
          picked_qty: pickedQty,
          version_no: { increment: 1 },
          updated_by: context.actor?.appUserId == null && context.appUserId == null
            ? null : BigInt(context.actor?.appUserId ?? context.appUserId as number),
          updated_at: new Date(),
        },
      });
      if (context.actor?.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
        actor: context.actor.terminalAudit, targetTypeCode: 'PICKING_LINE',
        targetId: line.picking_line_id, eventTypeCode: 'PICK',
      });
    });

    // ⑧ ④a 의 상세 되읽기를 그대로 쓴다 — `pickSequenceRank` 가 «지시 안»의 다른 라인을
    //    봐야 나오는 파생이라 라인 하나만 읽어서는 못 짓는다.
    const detail = await this.queries.get(pickingOrderId);
    return detail.lines.find((row) => row.pickingLineId === pickingLineId) as PickingLineView;
  }

  /**
   * 차원 = 지시의 창고 + 라인의 위치·품목·LOT. 품질·재고·소유 3칸은 계약이 안 실어 잠근
   * 행에서 되읽는다 — 2행이면 어느 것을 낼지 정할 수 없다(문의 031 과 같은 자리).
   */
  private async move(tx: Prisma.TransactionClient, line: LineRow, delta: Prisma.Decimal): Promise<void> {
    const warehouse = await tx.warehouse.findUniqueOrThrow({
      where: { warehouse_id: line.warehouse_id },
      select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } },
    });
    const [row, ...rest] = await lockBalancesInOrder(tx, [
      {
        legalEntityId: warehouse.plant.legal_entity_id,
        businessUnitId: warehouse.business_unit_id,
        plantId: warehouse.plant_id,
        warehouseId: line.warehouse_id,
        locationId: line.location_id,
        itemId: line.item_id,
        lotKey: line.lot_id,
      },
    ]);
    const path = 'pickedQty';
    if (row === undefined) throw one(field(path, ERROR_CODE.NEGATIVE_BALANCE, '이 위치에 그 LOT 의 재고가 없습니다.'));
    // 설계 미정 — 문의 031. 출고(`issue-posting.ts:126-129`)와 «같은 문장·같은 코드»다.
    if (rest.length > 0) throw one(field(path, ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 낼지 정할 수 없습니다.'));
    await this.posting.pick(tx, [
      {
        dimension: {
          legalEntityId: row.legalEntityId,
          businessUnitId: row.businessUnitId,
          plantId: row.plantId,
          warehouseId: row.warehouseId,
          locationId: row.locationId,
          itemId: row.itemId,
          // ⚠ `lotKey` 는 COALESCE 0 이라 「LOT 없음」과 못 가른다 — 실제 컬럼을 쓴다(R-3).
          lotId: row.lotId,
          qualityStatusCode: row.quality_status_code,
          inventoryStatusCode: row.inventory_status_code,
          ownershipTypeCode: row.ownership_type_code,
          ownerPartnerId: row.owner_partner_id,
        },
        delta,
        // 예약을 거는 자리가 서버에 없어 오늘은 언제나 NULL 이다 — 문의 045(I-8.md §5).
        inventoryReservationId: line.inventory_reservation_id,
        field: path,
      },
    ]);
  }
}

/** 형식만 본다 — 저장할 칸이 없다(C-8 · `goods-issue-rules.ts:110-123` 과 같은 판정). */
function assertMoments(body: PickingLinePick): void {
  const errors: ErrorItem[] = [];
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate) ||
    Number.isNaN(Date.parse(`${body.businessDate}T00:00:00Z`))
  ) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'));
  }
  if (Number.isNaN(Date.parse(body.occurredAt))) {
    errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * ③ 이미 «출고된» 라인인가 — Δ<0(줄이는 정정)의 안전판이다. `reverse()` 가 `picked_qty` 를
 * 안 되돌리므로 취소된 출고도 막는 쪽에 남는다(§3-6 · R-14).
 * ⛔ 존재만으로 막지 않는다 — 등록이 전기 «전»에 `picking_line_id` 를 저장하므로 그러면
 *    `postImmediately=false` 로 등록만 해 둔 출고가 라인을 영구히 잠근다.
 */
async function assertNotIssued(tx: Prisma.TransactionClient, pickingLineId: number): Promise<void> {
  const issued = await tx.goods_issue_line.findFirst({
    where: { picking_line_id: pickingLineId, goods_issue: { status_code: { not: REGISTERED } } },
    select: { goods_issue_line_id: true },
  });
  if (issued !== null) throw one(field('pickedQty', ERROR_CODE.STATE_LOCKED, '이미 출고된 라인은 다시 피킹할 수 없습니다.'));
}

/** ④ 계약 `exclusiveMinimum: 0` + ⌜계획 수량 이하⌝ + ⌜스캔한 LOT 이 계획과 다르면 400⌝. */
function assertQty(pickedQty: Prisma.Decimal, line: LineRow, lotId: number | null | undefined): void {
  if (!pickedQty.greaterThan(0)) {
    // ⚠ 0 으로 «지울» 수는 없다 — `:unpick` 이 계약에 없다(알려둘 것 ⓜ).
    throw one(field('pickedQty', ERROR_CODE.RANGE, '0 보다 커야 합니다.'));
  }
  if (pickedQty.greaterThan(line.planned_qty)) {
    throw one(field('pickedQty', ERROR_CODE.RANGE, '계획 수량 이하여야 합니다.'));
  }
  if (lotId !== undefined && lotId !== null && BigInt(lotId) !== line.lot_id) {
    throw one(field('lotId', ERROR_CODE.INVALID, '계획과 다른 LOT 입니다.'));
  }
}

/**
 * ⑤ 차단 판정 **둘** — 축이 다르다(§6-5). ⓐ 미해제 `trace.lot_hold`(계약 `PickingLinePick`
 * ⌜보류 중인 LOT 이면 400 으로 막는다⌝) ⓑ `judgment_type_control.blocks_picking`(통제표가
 * 오늘 0행이라 안 막는다).
 * ⚠ 출고의 `assertLotNotBlocked` 는 `lot_hold` 를 **안 본다** — 어긋남이 아니라 계약이 두
 *   자리를 다르게 적었다(집는 자리 ↔ 이미 집은 것을 내보내는 자리).
 * ⚠ 계약 `PickingLine.held` 는 ⓐ 파생뿐이라 ⓑ 만 참인 라인은 화면이 활성으로 그린다(R-17 · ⓝ).
 */
async function assertPickable(tx: Prisma.TransactionClient, lotId: bigint): Promise<void> {
  const hold = await tx.lot_hold.findFirst({
    where: { lot_id: lotId, released_at: null },
    select: { lot_hold_id: true },
  });
  if (hold !== null) throw one(field('lotId', ERROR_CODE.STATE_LOCKED, '보류 중인 LOT 은 피킹할 수 없습니다.'));
  const lot = await tx.lot.findUniqueOrThrow({
    where: { lot_id: lotId },
    select: { status_code: true },
  });
  const blocked = await tx.judgment_type_control.findFirst({
    where: { blocks_picking: true, lot_status_code: lot.status_code },
    select: { code_value_id: true },
  });
  if (blocked !== null) throw one(field('lotId', ERROR_CODE.STATE_LOCKED, '피킹이 막힌 LOT 입니다.'));
}
