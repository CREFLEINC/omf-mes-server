import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { HU_STATUS_OPEN, HU_STATUS_PACKED } from '../../inventory/handling-unit/handling-unit-status';
import { PrismaService } from '../../prisma/prisma.service';
import { isDuplicateNo } from '../stock-reinstatement/stock-reinstatement.service';
import { StockTransferDetail, stockTransferLineView, stockTransferView } from '../stock-transfer/stock-transfer-view';

type Tx = Prisma.TransactionClient;

const TRANSFER_TYPE = 'LOCATION_MOVE';
const SOURCE_DOCUMENT_TYPE = 'STOCK_TRANSFER';
const POSTED = 'POSTED';
const OWNED = 'OWNED';
const NUMBER_RETRY = 3;

export interface LocationMoveLine {
  lotId: number;
  fromLocationId: number;
  toLocationId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  qty: number;
}

export interface LocationMoveCreate {
  warehouseId: number;
  businessDate: string;
  occurredAt: string;
  remarks?: string | null;
  lines: LocationMoveLine[];
}

interface Warehouse {
  plant_id: bigint;
  business_unit_id: bigint;
}

/**
 * 같은 창고 안 위치 이동(`POST /logistics/location-moves` · 사용자 결정 2026-10-29). 창고 이동 전표를 유형
 * `LOCATION_MOVE` 로 «도착까지 끝난» 채 만들고 원장은 줄마다 from·to 한 줄이다 — 재고 재등록과 같은 한 번의 행위다.
 * 도착이 맨 아래 위치인지는 재고 코어가 본다(`assertLeafDestinations`).
 */
@Injectable()
export class LocationMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
  ) {}

  async create(body: LocationMoveCreate, appUserId: number): Promise<StockTransferDetail> {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { warehouse_id: body.warehouseId, is_active: true },
      select: { plant_id: true, business_unit_id: true },
    });
    if (warehouse === null) throw invalid([field('warehouseId', ERROR_CODE.INVALID, '쓸 수 있는 창고가 아닙니다.')]);
    await this.assertLocations(body);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const transferNo = await this.numbering.next('STOCK_TRANSFER', warehouse.plant_id, body.businessDate);
        return await this.prisma.$transaction((tx) => this.post(tx, body, warehouse, transferNo, appUserId));
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) throw new ConflictException('user', '이동 번호를 매기지 못했습니다. 다시 시도해 주세요.');
      }
    }
  }

  /** 위치는 그 창고의 켜진 위치이고 출발과 도착이 달라야 한다. */
  private async assertLocations(body: LocationMoveCreate): Promise<void> {
    const ids = [...new Set(body.lines.flatMap((line) => [line.fromLocationId, line.toLocationId]))];
    const rows = await this.prisma.location.findMany({
      where: { location_id: { in: ids.map(BigInt) }, warehouse_id: body.warehouseId, is_active: true },
      select: { location_id: true },
    });
    const known = new Set(rows.map((row) => Number(row.location_id)));
    const errors: ErrorItem[] = [];
    body.lines.forEach((line, index) => {
      for (const key of ['fromLocationId', 'toLocationId'] as const) {
        if (!known.has(line[key])) errors.push(field(`lines[${index}].${key}`, ERROR_CODE.INVALID, '이 창고의 쓸 수 있는 위치가 아닙니다.'));
      }
      if (line.fromLocationId === line.toLocationId) {
        errors.push(field(`lines[${index}].toLocationId`, ERROR_CODE.INVALID, '출발과 도착 위치가 같습니다.'));
      }
    });
    if (errors.length > 0) throw invalid(errors);
  }

  private async post(
    tx: Tx, body: LocationMoveCreate, warehouse: Warehouse, transferNo: string, appUserId: number,
  ): Promise<StockTransferDetail> {
    const lots = await this.assertMovable(tx, body);
    const occurredAt = new Date(body.occurredAt);
    const transfer = await tx.stock_transfer.create({
      data: {
        stock_transfer_no: transferNo,
        transfer_type_code: TRANSFER_TYPE,
        from_business_unit_id: warehouse.business_unit_id,
        to_business_unit_id: warehouse.business_unit_id,
        from_warehouse_id: body.warehouseId,
        to_warehouse_id: body.warehouseId,
        requested_at: occurredAt,
        shipped_at: occurredAt,
        received_at: occurredAt,
        status_code: POSTED,
        remarks: body.remarks ?? null,
        created_by: appUserId,
        updated_by: appUserId,
        stock_transfer_line: {
          create: body.lines.map((line, index) => ({
            line_no: index + 1,
            item_id: lots[index].item_id,
            lot_id: lots[index].lot_id,
            requested_qty: line.qty,
            shipped_qty: line.qty,
            received_qty: line.qty,
            uom_id: lots[index].uom_id,
            from_location_id: line.fromLocationId,
            to_location_id: line.toLocationId,
            created_by: appUserId,
          })),
        },
      },
      include: { stock_transfer_line: { orderBy: { line_no: 'asc' } } },
    });

    const posted = await this.posting.post(tx, {
      // ⛔ 본문 영업일 그대로다(C-8).
      businessDate: body.businessDate,
      occurredAt,
      transactionTypeCode: SOURCE_DOCUMENT_TYPE,
      transactionNo: transferNo,
      statusCode: POSTED,
      plantId: Number(warehouse.plant_id),
      sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
      sourceDocumentId: Number(transfer.stock_transfer_id),
      idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${transferNo}`,
      createdBy: appUserId,
      lines: body.lines.map((line, index) => {
        const endpoint = (locationId: number) => ({
          warehouseId: body.warehouseId,
          locationId,
          qualityStatusCode: line.qualityStatusCode,
          inventoryStatusCode: line.inventoryStatusCode,
        });
        return {
          itemId: Number(lots[index].item_id),
          lotId: line.lotId,
          qty: line.qty,
          uomId: Number(lots[index].uom_id),
          from: endpoint(line.fromLocationId),
          to: endpoint(line.toLocationId),
          ownershipTypeCode: OWNED,
        };
      }),
    });
    const ledger = await tx.inventory_transaction_line.findMany({
      where: { inventory_transaction_id: posted.inventoryTransactionId, business_date: new Date(`${body.businessDate}T00:00:00.000Z`) },
      orderBy: { line_no: 'asc' },
      select: { inventory_transaction_line_id: true },
    });
    // 반출과 도착이 «같은 한 줄»이다 — 두 되짚기 칸에 같은 id(재고 재등록과 같다).
    for (const [index, line] of transfer.stock_transfer_line.entries()) {
      const ledgerLineId = ledger[index].inventory_transaction_line_id;
      await tx.stock_transfer_line.update({
        where: { stock_transfer_line_id: line.stock_transfer_line_id },
        data: { issue_transaction_line_id: ledgerLineId, receipt_transaction_line_id: ledgerLineId },
      });
    }
    return { stockTransfer: stockTransferView(transfer), lines: transfer.stock_transfer_line.map(stockTransferLineView) };
  }

  /**
   * 줄마다 LOT 을 풀고, 출발 잔액 행을 잠근 뒤 옮길 수 있는 수량(예약·피킹·보류를 뺀 `available_qty`)을 본다.
   * HU 에 담긴 LOT 은 막는다 — 잔액만 옮기면 상자의 위치와 어긋난다.
   */
  private async assertMovable(tx: Tx, body: LocationMoveCreate): Promise<{ lot_id: bigint; item_id: bigint; uom_id: bigint }[]> {
    const rows = await tx.lot.findMany({
      where: { lot_id: { in: body.lines.map((line) => BigInt(line.lotId)) } },
      select: { lot_id: true, item_id: true, uom_id: true },
    });
    const lotOf = new Map(rows.map((row) => [Number(row.lot_id), row]));
    const errors: ErrorItem[] = [];
    for (const [index, line] of body.lines.entries()) {
      const lot = lotOf.get(line.lotId);
      if (lot === undefined) {
        errors.push(field(`lines[${index}].lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
        continue;
      }
      const [balance] = await tx.$queryRaw<{ available_qty: Prisma.Decimal }[]>`
        SELECT available_qty FROM inventory.inventory_balance
         WHERE warehouse_id = ${BigInt(body.warehouseId)} AND location_id = ${BigInt(line.fromLocationId)}
           AND item_id = ${lot.item_id} AND lot_id = ${lot.lot_id}
           AND quality_status_code = ${line.qualityStatusCode} AND inventory_status_code = ${line.inventoryStatusCode}
           AND ownership_type_code = ${OWNED} AND owner_partner_id IS NULL
         FOR UPDATE`;
      if (balance === undefined || new Prisma.Decimal(balance.available_qty).lessThan(line.qty)) {
        errors.push(field(`lines[${index}].qty`, ERROR_CODE.NEGATIVE_BALANCE, '옮길 수 있는 수량(예약·피킹·보류를 뺀 수량)보다 많습니다.'));
      }
      const boxed = await tx.handling_unit_content.findFirst({
        where: {
          lot_id: lot.lot_id,
          handling_unit: { location_id: BigInt(line.fromLocationId), status_code: { in: [HU_STATUS_OPEN, HU_STATUS_PACKED] } },
        },
        select: { handling_unit_id: true },
      });
      if (boxed !== null) errors.push(field(`lines[${index}].lotId`, ERROR_CODE.STATE_LOCKED, 'HU 에 담긴 재고는 위치 이동으로 옮기지 않습니다.'));
    }
    if (errors.length > 0) throw invalid(errors);
    return body.lines.map((line) => lotOf.get(line.lotId) as { lot_id: bigint; item_id: bigint; uom_id: bigint });
  }
}

const invalid = (errors: ErrorItem[]): ContractException => new ContractException(HttpStatus.BAD_REQUEST, errors);
