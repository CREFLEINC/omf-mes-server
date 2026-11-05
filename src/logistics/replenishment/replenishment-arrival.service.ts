import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { localDate, zonedToUtc } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopfloorReceiptDetail } from '../shopfloor-receipt/shopfloor-receipt-view';
import { AlreadyReceivedError, ShopfloorReceiptCreateLine, ShopfloorReceiptService } from '../shopfloor-receipt/shopfloor-receipt.service';

export interface ArrivalQuery {
  plantId: unknown;
  productionWarehouseId?: unknown;
  goodsIssuedFrom?: string;
  goodsIssuedTo?: string;
  page?: unknown;
  size?: unknown;
}

/** 계약 `ReplenishmentArrivalReceive` — 줄은 `POST /shopfloor-receipts` 의 줄과 같은 모양. 도착 위치·W/O 는 서버가 채운다. */
export interface ArrivalReceive {
  businessDate: string;
  receivedAt: string;
  occurredAt: string;
  lines: ShopfloorReceiptCreateLine[];
}

/** 계약 `ShopfloorReceiptBulkCreate`. */
export interface ArrivalBulkReceive {
  businessDate: string;
  receivedAt: string;
  goodsIssueIds: number[];
}

export interface BulkResult {
  goodsIssueId: number;
  outcome: 'RECEIVED' | 'ALREADY_RECEIVED' | 'FAILED';
  shopfloorReceiptId?: number;
  message?: string;
}

const BULK_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ArrivalRow {
  goods_issue_id: bigint;
  goods_issue_no: string;
  issued_at: Date;
  material_issue_request_id: bigint;
  issue_request_no: string;
  replenishment_origin_code: string;
  warehouse_id: bigint;
  warehouse_name: string;
  destination_location_id: bigint;
  location_code: string;
  timezone_code: string;
}

/** 보충 출고 → 피킹 지시 → 창고 보충 요청을 잇는 조인 — 출고는 피킹을 원천 칸으로만 가리킨다(FK 없음). */
const ARRIVAL_FROM = Prisma.sql`
  FROM logistics.goods_issue gi
  JOIN logistics.picking_order po
    ON gi.source_document_type_code = 'PICKING_ORDER' AND po.picking_order_id = gi.source_document_id
  JOIN logistics.material_issue_request r
    ON po.source_document_type_code = 'MATERIAL_ISSUE_REQUEST' AND r.material_issue_request_id = po.source_document_id
  JOIN mdm.location l ON l.location_id = r.destination_location_id
  JOIN mdm.warehouse w ON w.warehouse_id = l.warehouse_id
  JOIN mdm.plant p ON p.plant_id = w.plant_id`;

/**
 * 창고 보충 도착 대기·수령(W-02-12 「도착 대기」 · 피처 004 · US2 · research R-6). 대기 = 창고 보충 요청 피킹에서 나온
 * `POSTED` 출고 가운데 생산창고 입고 기록이 없는 것. 수령은 모바일과 같은 서비스 함수(`ShopfloorReceiptService.receive`)다.
 */
@Injectable()
export class ReplenishmentArrivalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: ShopfloorReceiptService,
  ) {}

  async list(query: ArrivalQuery): Promise<PagedResponse<unknown>> {
    const page = pageRequest({ page: num(query.page), size: num(query.size) });
    const plantId = BigInt(Number(query.plantId));
    const plant = await this.prisma.plant.findUnique({ where: { plant_id: plantId }, select: { timezone_code: true } });
    if (plant === null) throw new NotFoundException('없는 공장입니다.');
    const where = this.where(plantId, query, plant.timezone_code);
    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<ArrivalRow[]>`
        SELECT gi.goods_issue_id, gi.goods_issue_no, gi.issued_at, r.material_issue_request_id, r.issue_request_no,
               r.replenishment_origin_code, w.warehouse_id, w.warehouse_name, l.location_id AS destination_location_id,
               l.location_code, p.timezone_code
        ${ARRIVAL_FROM} WHERE ${where}
        ORDER BY gi.issued_at, gi.goods_issue_id
        LIMIT ${page.take} OFFSET ${page.skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${ARRIVAL_FROM} WHERE ${where}`,
    ]);
    const lines = await this.prisma.goods_issue_line.findMany({
      where: { goods_issue_id: { in: rows.map((row) => row.goods_issue_id) } },
      include: { item: { select: { item_code: true, item_name: true } }, lot: { select: { lot_no: true } }, uom: { select: { uom_code: true } } },
      orderBy: [{ goods_issue_id: 'asc' }, { line_no: 'asc' }],
    });
    const today = localDate(new Date(), plant.timezone_code);
    return pagedResponse(
      rows.map((row) => ({
        goodsIssueId: Number(row.goods_issue_id),
        goodsIssueNo: row.goods_issue_no,
        issuedAt: row.issued_at.toISOString(),
        elapsedDays: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${localDate(row.issued_at, row.timezone_code)}T00:00:00Z`)) / DAY_MS),
        materialIssueRequestId: Number(row.material_issue_request_id),
        issueRequestNo: row.issue_request_no,
        replenishmentOriginCode: row.replenishment_origin_code,
        productionWarehouseId: Number(row.warehouse_id),
        productionWarehouseName: row.warehouse_name,
        destinationLocationId: Number(row.destination_location_id),
        destinationLocationCode: row.location_code,
        lines: lines
          .filter((line) => line.goods_issue_id === row.goods_issue_id)
          .map((line) => ({
            goodsIssueLineId: Number(line.goods_issue_line_id),
            itemId: Number(line.item_id),
            itemCode: line.item.item_code,
            itemName: line.item.item_name,
            lotId: Number(line.lot_id),
            lotNo: line.lot.lot_no,
            issueQty: line.issue_qty.toNumber(),
            uomId: Number(line.uom_id),
            uomCode: line.uom.uom_code,
          })),
      })),
      total,
      page,
    );
  }

  /** 웹 개별 수령 — 보충 출고만(아니면 400), 이미 수령이면 409 `ALREADY_RECEIVED`. */
  async receive(goodsIssueId: number, body: ArrivalReceive, appUserId: number): Promise<ShopfloorReceiptDetail> {
    const destinationLocationId = await this.arrivalDestination(goodsIssueId);
    if (destinationLocationId === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('goodsIssueId', ERROR_CODE.INVALID, '창고 보충 출고가 아닙니다.')]);
    }
    try {
      return await this.receipts.receive(
        { goodsIssueId, workOrderId: null, destinationLocationId: Number(destinationLocationId), ...body },
        { appUserId },
        { alreadyReceivedAsError: true },
      );
    } catch (error) {
      if (error instanceof AlreadyReceivedError) {
        throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: 'ALREADY_RECEIVED', message: '이미 수령한 출고입니다.' }]);
      }
      throw error;
    }
  }

  /** 일괄 수령 — 건마다 따로 확정(한 건 실패가 나머지를 막지 않는다). 줄마다 받은 수량 = 출고 수량, 차이 없음. */
  async bulk(body: ArrivalBulkReceive, appUserId: number): Promise<{ results: BulkResult[] }> {
    if (body.goodsIssueIds.length > BULK_LIMIT) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('goodsIssueIds', ERROR_CODE.RANGE, `한 번에 ${BULK_LIMIT}건까지 받습니다.`)]);
    }
    const results: BulkResult[] = [];
    for (const goodsIssueId of [...new Set(body.goodsIssueIds)]) {
      results.push(await this.bulkOne(goodsIssueId, body, appUserId));
    }
    return { results };
  }

  private async bulkOne(goodsIssueId: number, body: ArrivalBulkReceive, appUserId: number): Promise<BulkResult> {
    try {
      const lines = await this.prisma.goods_issue_line.findMany({ where: { goods_issue_id: goodsIssueId }, orderBy: { line_no: 'asc' } });
      const created = await this.receive(
        goodsIssueId,
        {
          businessDate: body.businessDate,
          receivedAt: body.receivedAt,
          occurredAt: body.receivedAt,
          lines: lines.map((line) => ({
            goodsIssueLineId: Number(line.goods_issue_line_id),
            itemId: Number(line.item_id),
            lotId: Number(line.lot_id),
            issuedQty: line.issue_qty.toNumber(),
            receivedQty: line.issue_qty.toNumber(),
            uomId: Number(line.uom_id),
          })),
        },
        appUserId,
      );
      return { goodsIssueId, outcome: 'RECEIVED', shopfloorReceiptId: created.shopfloorReceipt.shopfloorReceiptId };
    } catch (error) {
      if (error instanceof ContractException && error.getStatus() === HttpStatus.CONFLICT) {
        return { goodsIssueId, outcome: 'ALREADY_RECEIVED', message: '이미 수령한 출고입니다.' };
      }
      return { goodsIssueId, outcome: 'FAILED', message: messageOf(error) };
    }
  }

  /** 보충 출고면 그 도착 위치(출고가 실은 도착지 → 없으면 요청의 도착 위치), 아니면 null. */
  private async arrivalDestination(goodsIssueId: number): Promise<bigint | null> {
    const [row] = await this.prisma.$queryRaw<{ destination: bigint }[]>`
      SELECT COALESCE(CASE WHEN gi.destination_type_code = 'LOCATION' THEN gi.destination_id END, r.destination_location_id) AS destination
      ${ARRIVAL_FROM}
      WHERE gi.goods_issue_id = ${goodsIssueId} AND r.request_type_code = 'REPLENISHMENT'`;
    return row?.destination ?? null;
  }

  private where(plantId: bigint, query: ArrivalQuery, timezone: string): Prisma.Sql {
    const parts = [
      Prisma.sql`r.request_type_code = 'REPLENISHMENT'`,
      Prisma.sql`gi.status_code = 'POSTED'`,
      Prisma.sql`w.plant_id = ${plantId}`,
      Prisma.sql`NOT EXISTS (SELECT 1 FROM logistics.shopfloor_receipt s WHERE s.goods_issue_id = gi.goods_issue_id)`,
    ];
    const warehouseId = num(query.productionWarehouseId);
    if (warehouseId !== undefined) parts.push(Prisma.sql`w.warehouse_id = ${BigInt(warehouseId)}`);
    // 날짜 조건은 공장 현지 날짜의 00:00 순간으로 바꿔 건다(캐스팅 없이).
    if (query.goodsIssuedFrom !== undefined) parts.push(Prisma.sql`gi.issued_at >= ${zonedToUtc(query.goodsIssuedFrom, '00:00:00', timezone)}`);
    if (query.goodsIssuedTo !== undefined) {
      const next = new Date(Date.parse(`${query.goodsIssuedTo}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
      parts.push(Prisma.sql`gi.issued_at < ${zonedToUtc(next, '00:00:00', timezone)}`);
    }
    return Prisma.join(parts, ' AND ');
  }
}

function num(value: unknown): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function messageOf(error: unknown): string {
  if (error instanceof ContractException) {
    const body = error.getResponse() as { errors?: { message?: string }[] };
    return body.errors?.map((e) => e.message).filter(Boolean).join(' · ') || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
