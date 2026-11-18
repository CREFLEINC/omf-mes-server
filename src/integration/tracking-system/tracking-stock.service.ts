import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { allocatePicking } from '../../core/picking';
import { PrismaService } from '../../prisma/prisma.service';
import { postTrackingIssue } from './goods-issue-write';
import { issuableStock } from './issuable-stock';
import { claimTransmission, screen } from './tracking-transmission';

type Db = Prisma.TransactionClient;

/** 수량 출고 — 시리얼 없는 품목(S410)을 품목·수량으로 낸다(flowtrack 연동 제안 §3-5). */
export interface QtyIssue {
  transmissionId: string;
  warehouseCode: string;
  itemCode: string;
  qty: number;
  businessDate: string;
}

export interface StockLevel {
  itemCode: string;
  qty: number;
}

const KIND = 'QTY_ISSUE';
const ISSUE_TYPE = 'SHIPMENT';
const SOURCE_DOCUMENT_TYPE = 'TRACKING_TRANSMISSION';

/**
 * 재고 조회와 수량 출고 — 둘 다 «수량 출고가 실제로 뺄 수 있는 재고»를 본다(사용자 2026-11-17). 그래서 조회한 만큼 보내면 들어간다.
 * 시리얼이 달린 LOT 은 둘 다 보지 않는다. 창고와 품목은 단말 공장에서 찾는다.
 */
@Injectable()
export class TrackingStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly posting: InventoryPostingService,
  ) {}

  /** 품목을 주면 그 품목 하나(재고가 없으면 0), 안 주면 재고가 있는 품목 전부. */
  async stocks(plantId: bigint, warehouseCode: string, itemCode?: string): Promise<{ items: StockLevel[] }> {
    const warehouseId = await warehouseOf(this.prisma, plantId, warehouseCode);
    const item = itemCode === undefined ? undefined : await itemOf(this.prisma, itemCode);
    const stock = await issuableStock(this.prisma, {
      warehouseId, ...(item === undefined ? {} : { itemIds: [item.item_id] }), lock: false, withoutSerials: true,
    });
    const sums = new Map<bigint, Prisma.Decimal>(item === undefined ? [] : [[item.item_id, new Prisma.Decimal(0)]]);
    for (const row of stock) sums.set(row.itemId, (sums.get(row.itemId) ?? new Prisma.Decimal(0)).plus(row.availableQty));
    const codes = await this.prisma.item.findMany({ where: { item_id: { in: [...sums.keys()] } }, select: { item_id: true, item_code: true } });
    const codeOf = new Map(codes.map((row) => [row.item_id, row.item_code]));
    return {
      items: [...sums.entries()]
        .map(([id, qty]) => ({ itemCode: codeOf.get(id) as string, qty: qty.toNumber() }))
        .sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
    };
  }

  /** 그 창고의 LOT 을 오래된 것부터 빼 출고 전표 하나로 남긴다. 모자라면 거절한다. 출고 시각은 받은 시각이다(본문은 날짜뿐). */
  async issue(input: QtyIssue, plantId: bigint): Promise<{ replayed: boolean }> {
    const warehouseId = await warehouseOf(this.prisma, plantId, input.warehouseCode);
    const item = await itemOf(this.prisma, input.itemCode);
    // 번호는 트랜잭션을 열기 전에 뽑는다(I-2 R-2) — 다시 온 전송은 번호를 버린다(결번 허용).
    const issueNo = await this.numbering.next('GOODS_ISSUE', plantId, input.businessDate);
    const occurredAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      const transmission = await claimTransmission(tx, {
        transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrderId: null, payload: input,
      });
      if (transmission === null) return { replayed: true };
      const stock = await issuableStock(tx, { warehouseId, itemIds: [item.item_id], lock: true, withoutSerials: true });
      const { orders, shortages } = allocatePicking(
        [{ lineNo: 1, itemId: item.item_id, uomId: item.base_uom_id, qty: new Prisma.Decimal(input.qty) }], stock, new Set(),
      );
      if (shortages.length > 0) {
        throw screen(ERROR_CODE.NEGATIVE_BALANCE, `${input.warehouseCode} 의 ${input.itemCode} 출고할 수 있는 재고가 ${shortages[0].shortQty.toString()}개 모자랍니다.`);
      }
      const { goodsIssueId } = await postTrackingIssue(tx, this.posting, {
        goodsIssueNo: issueNo, issueTypeCode: ISSUE_TYPE, sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE, sourceDocumentId: transmission,
        warehouseId, occurredAt, businessDate: input.businessDate,
      }, orders[0].lines.map((line) => ({ itemId: line.itemId, lotId: line.lotId, uomId: line.uomId, locationId: line.locationId, qty: line.plannedQty })));
      await tx.tracking_transmission_document.create({
        data: { tracking_transmission_id: transmission, document_type_code: 'GOODS_ISSUE', document_id: goodsIssueId },
      });
      return { replayed: false };
    }, { timeout: 15_000, maxWait: 5_000 });
  }
}

/** 다른 공장의 창고는 없는 창고와 같게 답한다. */
async function warehouseOf(db: Pick<Db, 'warehouse'>, plantId: bigint, warehouseCode: string): Promise<bigint> {
  const warehouse = await db.warehouse.findUnique({
    where: { plant_id_warehouse_code: { plant_id: plantId, warehouse_code: warehouseCode } },
    select: { warehouse_id: true, is_active: true },
  });
  if (warehouse === null || !warehouse.is_active) {
    throw one(field('warehouseCode', ERROR_CODE.INVALID, `이 공장에 없는 창고입니다: ${warehouseCode}`));
  }
  return warehouse.warehouse_id;
}

async function itemOf(db: Pick<Db, 'item'>, itemCode: string): Promise<{ item_id: bigint; base_uom_id: bigint }> {
  const item = await db.item.findUnique({ where: { item_code: itemCode }, select: { item_id: true, base_uom_id: true } });
  if (item === null) throw one(field('itemCode', ERROR_CODE.INVALID, `MES 에 없는 품목입니다: ${itemCode}`));
  return item;
}
