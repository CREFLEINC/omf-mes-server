import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { PUTAWAY_STAGING, filter } from '../../common/master';
import { PRODUCTION_WAREHOUSE } from '../../core/material-issue/production-warehouse';
import { VERDICT_MESSAGES } from '../../logistics/putaway-direct/location-verdict';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { unprintedSplitLotIds } from '../../logistics/split-material-lot/split-material-lot-query.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FinalCloseProbe } from './final-close';
import {
  MATERIAL_RETURN_LINE_INCLUDE,
  MaterialReturnView,
  materialReturnView,
} from './material-return-view';
import { RETURN_MESSAGES } from './material-return.constants';
import { loadReturnLots } from './return-lots';
import { returnWorkOrderLots, returnWorkOrders } from './return-work-orders';

interface ItemRef { itemId: number; itemCode: string; itemName: string }

/** 계약 `MaterialReturnWorkOrder`(§2). */
export interface MaterialReturnWorkOrder {
  workOrderId: number; workOrderNo: string; item: ItemRef; processName: string | null; lineName: string | null;
  lastIssuedAt: string; finalized: boolean; returnableLotCount: number; unprintedLotCount: number;
  /** 나간 자재 요약 — 가장 최근 출고 LOT 의 자재 품목 + 나머지 자재 품목 수. */
  returnableMaterial: { item: ItemRef; otherItemCount: number };
}

/** 계약 `MaterialReturnWorkOrderLot`(§3). */
export interface MaterialReturnWorkOrderLot {
  lotId: number; lotNo: string; item: ItemRef; uom: { uomId: number; uomCode: string; decimalScale: number };
  goodsIssueLineId: number; issuedAt: string; issueQty: number; returnableQty: number; labelUnprinted: boolean;
}

/** 계약 `MaterialReturnLotLookup`(§1). */
export interface MaterialReturnLotLookup {
  lotId: number;
  lotNo: string;
  item: { itemId: number; itemCode: string; itemName: string };
  uom: { uomId: number; uomCode: string; decimalScale: number };
  returnableQty: number;
  workOrder: { workOrderId: number; workOrderNo: string; finalized: boolean };
  issueWarehouse: { warehouseId: number; warehouseCode: string; warehouseName: string };
  labelUnprinted: boolean;
}

/** 계약 `MaterialReturnLocationLookup` — 받는 위치(PDA 스캔)와 그 생산창고. */
export interface MaterialReturnLocationLookup {
  locationId: number;
  locationCode: string;
  locationName: string;
  warehouse: { warehouseId: number; warehouseCode: string; warehouseName: string };
}

/** 계약 질의 6 전건 — 필수는 하나도 없다. 형·기본값은 `@Contract` 가드가 이미 맞춰 둔다. */
export interface MaterialReturnListQuery {
  workOrderId?: unknown;
  statusCode?: string;
  requestedFrom?: string;
  requestedTo?: string;
  page?: number;
  size?: number;
}

/** 정렬 키가 계약에 **없다** ⇒ 서버가 고정한다(§5-1 과 같은 근거 · 동률은 PK 로 닫는다). */
export const MATERIAL_RETURN_ORDER_BY: Prisma.material_returnOrderByWithRelationInput[] = [
  { requested_at: 'desc' },
  { material_return_id: 'desc' },
];

/** 반납 조회 — 목록·단건(I-10 PR ① · ETag·403 미선언)과 반납 입고 LOT 조회(피처 019 §1). */
@Injectable()
export class MaterialReturnQueryService {
  constructor(private readonly prisma: PrismaService, private readonly finalClose: FinalCloseProbe) {}

  /**
   * LOT 스캔(§1) — 반납할 수 있으면 품목·반납 가능 양·귀속될 W/O·출고 생산창고. `plantId` 가 있으면(단말) 그 공장 LOT 만 찾는다.
   * 없으면 404, 반납 대상이 아니면 400 NOT_RETURNABLE, 남은 양이 없으면 400 NOTHING_TO_RETURN — 화면은 문구를 그대로 보인다.
   */
  /** W/O 로 찾기 목록(§2) — 최종 마감 W/O 도 `finalized` 로 보인다. */
  async workOrders(plantId: bigint | null, query: { q?: string; page?: number; size?: number }): Promise<PagedResponse<MaterialReturnWorkOrder>> {
    const page = pageRequest(query);
    const { rows, unprinted } = await returnWorkOrders(this.prisma, plantId, query.q?.trim(), page);
    const finalized = await this.finalClose.finalizedWorkOrders(this.prisma, rows.map((row) => row.work_order_id));
    const items = rows.map((row) => ({
      workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no,
      item: { itemId: Number(row.item_id), itemCode: row.item_code, itemName: row.item_name },
      processName: row.process_name, lineName: row.line_name, lastIssuedAt: row.last_issued_at.toISOString(),
      finalized: finalized.has(row.work_order_id), returnableLotCount: Number(row.lot_count), unprintedLotCount: unprinted.get(row.work_order_id) ?? 0,
      returnableMaterial: {
        item: { itemId: Number(row.material_item_id), itemCode: row.material_item_code, itemName: row.material_item_name },
        otherItemCount: Number(row.material_item_count) - 1,
      },
    }));
    return pagedResponse(items, rows.length === 0 ? 0 : Number(rows[0].total), page);
  }

  /** W/O 의 자재 LOT(§3) — 없는 W/O(단말이면 단말 공장 밖 라인의 W/O 도)는 404. */
  async workOrderLots(plantId: bigint | null, workOrderId: number): Promise<{ items: MaterialReturnWorkOrderLot[] }> {
    const workOrder = await this.prisma.work_order.findUnique({
      where: { work_order_id: BigInt(workOrderId) }, select: { production_line: { select: { plant_id: true } } },
    });
    if (workOrder === null || (plantId !== null && workOrder.production_line !== null && workOrder.production_line.plant_id !== plantId)) {
      throw new NotFoundException('W/O 를 찾을 수 없습니다.');
    }
    const { lots, unprinted } = await returnWorkOrderLots(this.prisma, plantId, BigInt(workOrderId));
    const facts = await this.prisma.lot.findMany({
      where: { lot_id: { in: lots.map((lot) => lot.lot_id) } },
      select: { lot_id: true, lot_no: true, item: { select: { item_id: true, item_code: true, item_name: true } }, uom: { select: { uom_id: true, uom_code: true, decimal_scale: true } } },
    });
    const byId = new Map(facts.map((lot) => [lot.lot_id, lot]));
    return {
      items: lots.map((lot) => {
        const fact = byId.get(lot.lot_id);
        if (fact === undefined) throw new Error(`LOT ${lot.lot_id} 를 다시 읽지 못했다`);
        return {
          lotId: Number(lot.lot_id), lotNo: fact.lot_no,
          item: { itemId: Number(fact.item.item_id), itemCode: fact.item.item_code, itemName: fact.item.item_name },
          uom: { uomId: Number(fact.uom.uom_id), uomCode: fact.uom.uom_code, decimalScale: fact.uom.decimal_scale },
          goodsIssueLineId: Number(lot.goods_issue_line_id), issuedAt: lot.issued_at.toISOString(),
          issueQty: Number(lot.issue_qty), returnableQty: Number(lot.returnable), labelUnprinted: unprinted.has(lot.lot_id),
        };
      }),
    };
  }

  /**
   * 받는 위치 스캔(PDA) — 위치 코드(전역 유일 · #292)로 찾는다. `plantId` 가 있으면(단말) 그 공장 창고 위치만 찾는다.
   * 없음·사용 중지(위치나 창고)·남의 공장은 404, 생산창고 위치가 아니면 400 NOT_PRODUCTION_WAREHOUSE(생산창고 판정은
   * 출고·보충과 같은 `warehouse_type_code = PRODUCTION`), 적치 대기 자리는 400 STAGING(PDA 적치 위치 판정 `verdictOf` 와 같다 —
   * 「창고 전체」는 받는다). LOT 에 매인 판정(불량창고·지정 품목·미지정 확인)은 등록(POST)이 줄마다 한다.
   */
  async locationLookup(locationCode: string, plantId: bigint | null): Promise<MaterialReturnLocationLookup> {
    const row = await this.prisma.location.findFirst({
      where: { location_code: locationCode },
      select: {
        location_id: true, location_code: true, location_name: true, is_active: true, system_role_code: true,
        warehouse: { select: { warehouse_id: true, warehouse_code: true, warehouse_name: true, warehouse_type_code: true, is_active: true, plant_id: true } },
      },
    });
    if (row === null || !row.is_active || !row.warehouse.is_active || (plantId !== null && row.warehouse.plant_id !== plantId)) {
      throw new NotFoundException(RETURN_MESSAGES.LOCATION_NOT_FOUND);
    }
    if (row.warehouse.warehouse_type_code !== PRODUCTION_WAREHOUSE) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('locationCode', 'NOT_PRODUCTION_WAREHOUSE', RETURN_MESSAGES.NOT_PRODUCTION_WAREHOUSE)]);
    }
    if (row.system_role_code === PUTAWAY_STAGING) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('locationCode', 'STAGING', VERDICT_MESSAGES.STAGING)]);
    }
    return {
      locationId: Number(row.location_id), locationCode: row.location_code, locationName: row.location_name,
      warehouse: { warehouseId: Number(row.warehouse.warehouse_id), warehouseCode: row.warehouse.warehouse_code, warehouseName: row.warehouse.warehouse_name },
    };
  }

  async lotLookup(lotNo: string, plantId: bigint | null): Promise<MaterialReturnLotLookup> {
    const lot = await this.prisma.lot.findFirst({
      where: { lot_no: lotNo, ...(plantId === null ? {} : { plant_id: plantId }) }, select: { lot_id: true },
    });
    if (lot === null) throw new NotFoundException('LOT 을 찾을 수 없습니다.');
    const facts = (await loadReturnLots(this.prisma, this.finalClose, [lot.lot_id], plantId)).get(lot.lot_id);
    if (facts === undefined || facts === 'NOT_FOUND') throw new NotFoundException('LOT 을 찾을 수 없습니다.');
    if (typeof facts === 'string') throw new ContractException(HttpStatus.BAD_REQUEST, [field('lotNo', facts, RETURN_MESSAGES[facts])]);
    const [warehouse, unprinted] = await Promise.all([
      this.prisma.warehouse.findUniqueOrThrow({
        where: { warehouse_id: facts.issue.sourceWarehouseId }, select: { warehouse_code: true, warehouse_name: true },
      }),
      unprintedSplitLotIds(this.prisma, [facts.lotId]),
    ]);
    return {
      lotId: Number(facts.lotId), lotNo: facts.lotNo,
      item: { itemId: Number(facts.itemId), itemCode: facts.itemCode, itemName: facts.itemName },
      uom: { uomId: Number(facts.uomId), uomCode: facts.uomCode, decimalScale: facts.decimalScale },
      returnableQty: facts.returnable.toNumber(),
      workOrder: { workOrderId: Number(facts.issue.workOrderId), workOrderNo: facts.issue.workOrderNo, finalized: facts.finalized },
      issueWarehouse: { warehouseId: Number(facts.issue.sourceWarehouseId), warehouseCode: warehouse.warehouse_code, warehouseName: warehouse.warehouse_name },
      labelUnprinted: unprinted.has(facts.lotId),
    };
  }

  async list(query: MaterialReturnListQuery): Promise<PagedResponse<MaterialReturnView>> {
    const page = pageRequest(query);
    // 반개구간 — From 이상 · To 미만(공유계약 L-3).
    const requestedAt = {
      ...(query.requestedFrom === undefined ? {} : { gte: new Date(query.requestedFrom) }),
      ...(query.requestedTo === undefined ? {} : { lt: new Date(query.requestedTo) }),
    };
    const where: Prisma.material_returnWhereInput = {
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      // 문자 그대로 건다 — `x-no-code-key` 라 대조할 값 목록이 아예 없다(I-10 §5-3).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(Object.keys(requestedAt).length === 0 ? {} : { requested_at: requestedAt }),
    };

    const [rows, total] = await Promise.all([
      // ⭐ 목록에도 라인을 싣는다 — 목록·상세가 같은 `MaterialReturn` 스키마라 비우면 자리마다
      //    모양이 갈린다(I-10 §5-3).
      this.prisma.material_return.findMany({
        where,
        orderBy: MATERIAL_RETURN_ORDER_BY,
        skip: page.skip,
        take: page.take,
        include: MATERIAL_RETURN_LINE_INCLUDE,
      }),
      this.prisma.material_return.count({ where }),
    ]);
    return pagedResponse(rows.map((row) => materialReturnView(row)), total, page);
  }

  /** 없으면 404(계약 선언). 라인은 `line_no` 오름차순 — 칸이 물리에 실재한다(§5-4). */
  async detail(materialReturnId: number): Promise<MaterialReturnView> {
    const row = await this.prisma.material_return.findUnique({
      where: { material_return_id: BigInt(materialReturnId) },
      include: MATERIAL_RETURN_LINE_INCLUDE,
    });
    if (row === null) throw new NotFoundException('없는 자재 반출입니다.');
    return materialReturnView(row);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(`shopfloor-receipt-query.service.ts:70` 사본). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
