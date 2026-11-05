import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { pairKey } from '../../core/material-issue/planned-stock';
import { replenishmentStock } from '../../core/material-issue/replenishment-stock';
import { PrismaService } from '../../prisma/prisma.service';
import { MATERIAL_ITEM_TYPES, productionWarehousePlant, sourceWarehouseErrors, throwIfAny } from './replenishment-rules';

/** 계약 `ReplenishmentItemCreate`. */
export interface ReplenishmentItemCreate {
  productionWarehouseId: number;
  itemId: number;
  reorderPointQty: number;
  targetQty: number;
  sourceWarehouseId: number;
}

/** 계약 `ReplenishmentItemUpdate` — 창고·품목은 바꾸지 않는다(지우고 다시 넣는다). */
export interface ReplenishmentItemUpdate {
  reorderPointQty: number;
  targetQty: number;
  sourceWarehouseId: number;
  versionNo: number;
}

export interface ReplenishmentItemQuery {
  plantId: unknown;
  productionWarehouseId?: unknown;
  itemId?: unknown;
  sourceWarehouseId?: unknown;
  belowPointOnly?: unknown;
  page?: unknown;
  size?: unknown;
}

const AUDIT_TARGET = 'REPLENISHMENT_ITEM';

const ROW_INCLUDE = {
  warehouse: { select: { warehouse_code: true, warehouse_name: true } },
  source_warehouse: { select: { warehouse_code: true, warehouse_name: true } },
  item: { select: { item_code: true, item_name: true, uom: { select: { uom_code: true } } } },
} satisfies Prisma.replenishment_itemInclude;

type Row = Prisma.replenishment_itemGetPayload<{ include: typeof ROW_INCLUDE }>;
export type ReplenishmentItemView = ReturnType<typeof view>;

/**
 * 관리 품목(W-02-12 · 피처 004 · research R-9). 생산 창고마다 품목의 보충 시점·유지량·출고 자재 창고를 둔다.
 * 계산 값(가용·예정·쓸 수 있는 양·진행 중 보충·기준 아래)은 저장하지 않고 읽을 때 계산한다.
 */
@Injectable()
export class ReplenishmentItemService {
  constructor(private readonly prisma: PrismaService) {}

  /** 「기준 아래만」은 계산 값으로 거르므로 공장의 행을 모두 계산한 뒤 쪽을 나눈다 — 관리 품목은 공장당 수백 건 규모다. */
  async list(query: ReplenishmentItemQuery): Promise<PagedResponse<ReplenishmentItemView>> {
    const page = pageRequest({ page: num(query.page), size: num(query.size) });
    const rows = await this.prisma.replenishment_item.findMany({
      where: {
        warehouse: { plant_id: num(query.plantId) },
        ...optional('warehouse_id', query.productionWarehouseId),
        ...optional('item_id', query.itemId),
        ...optional('source_warehouse_id', query.sourceWarehouseId),
      },
      include: ROW_INCLUDE,
      orderBy: [{ warehouse: { warehouse_code: 'asc' } }, { item: { item_code: 'asc' } }],
    });
    const views = await this.views(this.prisma, rows);
    const filtered = query.belowPointOnly === true || query.belowPointOnly === 'true' ? views.filter((v) => v.belowPoint) : views;
    return pagedResponse(filtered.slice(page.skip, page.skip + page.take), filtered.length, page);
  }

  async create(tx: Prisma.TransactionClient, body: ReplenishmentItemCreate, appUserId: number): Promise<ReplenishmentItemView> {
    const warehouseId = BigInt(body.productionWarehouseId);
    const plantId = await productionWarehousePlant(tx, warehouseId);
    await this.assertBody(tx, body, { warehouseId, plantId });
    await this.assertMaterial(tx, BigInt(body.itemId));
    const duplicate = await tx.replenishment_item.findUnique({
      where: { warehouse_id_item_id: { warehouse_id: warehouseId, item_id: BigInt(body.itemId) } },
      select: { replenishment_item_id: true },
    });
    if (duplicate !== null) {
      throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'field', field: 'itemId', code: 'DUPLICATE', message: '이 생산 창고에 이미 있는 관리 품목입니다.' }]);
    }
    const row = await tx.replenishment_item.create({
      data: {
        warehouse_id: warehouseId,
        item_id: BigInt(body.itemId),
        reorder_point_qty: body.reorderPointQty,
        target_qty: body.targetQty,
        source_warehouse_id: BigInt(body.sourceWarehouseId),
        created_by: appUserId,
        updated_by: appUserId,
      },
      include: ROW_INCLUDE,
    });
    await audit(tx, row.replenishment_item_id, 'CREATE', appUserId, snapshot(row));
    return (await this.views(tx, [row]))[0];
  }

  async update(tx: Prisma.TransactionClient, id: number, body: ReplenishmentItemUpdate, appUserId: number): Promise<ReplenishmentItemView> {
    const current = await this.find(tx, id);
    const plantId = await productionWarehousePlant(tx, current.warehouse_id);
    await this.assertBody(tx, body, { warehouseId: current.warehouse_id, plantId });
    const updated = await tx.replenishment_item.updateMany({
      where: { replenishment_item_id: id, version_no: body.versionNo },
      data: {
        reorder_point_qty: body.reorderPointQty,
        target_qty: body.targetQty,
        source_warehouse_id: BigInt(body.sourceWarehouseId),
        updated_at: new Date(),
        updated_by: appUserId,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    const row = await this.find(tx, id);
    await audit(tx, row.replenishment_item_id, 'UPDATE', appUserId, snapshot(row));
    return (await this.views(tx, [row]))[0];
  }

  /** 행을 지운다 — 이미 나간 보충 요청은 그대로 간다(FR-028). 그 수를 안내용으로 돌려준다. */
  async remove(tx: Prisma.TransactionClient, id: number, appUserId: number): Promise<{ inProgressRequestCount: number }> {
    const row = await this.find(tx, id);
    const stock = await replenishmentStock(tx, [{ warehouseId: row.warehouse_id, itemId: row.item_id }]);
    await tx.replenishment_item.delete({ where: { replenishment_item_id: id } });
    await audit(tx, row.replenishment_item_id, 'DELETE', appUserId, snapshot(row));
    return { inProgressRequestCount: stock.get(pairKey(row.warehouse_id, row.item_id))?.inProgressRequestCount ?? 0 };
  }

  private async find(tx: Prisma.TransactionClient, id: number): Promise<Row> {
    const row = await tx.replenishment_item.findUnique({ where: { replenishment_item_id: id }, include: ROW_INCLUDE });
    if (row === null) throw new NotFoundException('없는 관리 품목입니다.');
    return row;
  }

  private async assertBody(
    tx: Prisma.TransactionClient,
    body: { reorderPointQty: number; targetQty: number; sourceWarehouseId: number },
    scope: { warehouseId: bigint; plantId: bigint },
  ): Promise<void> {
    const errors: ErrorItem[] = [];
    if (!(body.reorderPointQty > 0)) errors.push(field('reorderPointQty', ERROR_CODE.RANGE, '보충 시점은 0 보다 커야 합니다.'));
    if (!(body.targetQty > body.reorderPointQty)) errors.push(field('targetQty', ERROR_CODE.RANGE, '유지량은 보충 시점보다 커야 합니다.'));
    errors.push(
      ...(await sourceWarehouseErrors(
        tx,
        { sourceWarehouseIds: [BigInt(body.sourceWarehouseId)], productionWarehouseId: scope.warehouseId, plantId: scope.plantId },
        () => 'sourceWarehouseId',
      )),
    );
    throwIfAny(errors);
  }

  private async assertMaterial(tx: Prisma.TransactionClient, itemId: bigint): Promise<void> {
    const item = await tx.item.findUnique({ where: { item_id: itemId }, select: { is_active: true, item_type_code: true } });
    if (item === null || !item.is_active || !MATERIAL_ITEM_TYPES.includes(item.item_type_code)) {
      throwIfAny([field('itemId', ERROR_CODE.INVALID, '사용 중인 원자재·부자재 품목만 관리 품목이 됩니다.')]);
    }
  }

  private async views(db: Prisma.TransactionClient, rows: Row[]): Promise<ReplenishmentItemView[]> {
    const stock = await replenishmentStock(db, rows.map((row) => ({ warehouseId: row.warehouse_id, itemId: row.item_id })));
    return rows.map((row) => view(row, stock.get(pairKey(row.warehouse_id, row.item_id))));
  }
}

function view(row: Row, stock: Awaited<ReturnType<typeof replenishmentStock>> extends Map<string, infer S> ? S | undefined : never) {
  const usable = stock?.usableQty.toNumber() ?? 0;
  return {
    replenishmentItemId: Number(row.replenishment_item_id),
    productionWarehouseId: Number(row.warehouse_id),
    productionWarehouseCode: row.warehouse.warehouse_code,
    productionWarehouseName: row.warehouse.warehouse_name,
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    sourceWarehouseId: Number(row.source_warehouse_id),
    sourceWarehouseCode: row.source_warehouse.warehouse_code,
    sourceWarehouseName: row.source_warehouse.warehouse_name,
    reorderPointQty: row.reorder_point_qty.toNumber(),
    targetQty: row.target_qty.toNumber(),
    uomCode: row.item.uom.uom_code,
    availableQty: stock?.availableQty.toNumber() ?? 0,
    plannedQty: stock?.plannedQty.toNumber() ?? 0,
    usableQty: usable,
    inProgressQty: stock?.inProgressQty.toNumber() ?? 0,
    belowPoint: row.reorder_point_qty.gt(usable),
    versionNo: row.version_no,
  };
}

function snapshot(row: Row) {
  return {
    warehouseId: Number(row.warehouse_id),
    itemId: Number(row.item_id),
    reorderPointQty: row.reorder_point_qty.toNumber(),
    targetQty: row.target_qty.toNumber(),
    sourceWarehouseId: Number(row.source_warehouse_id),
  };
}

async function audit(tx: Prisma.TransactionClient, id: bigint, type: 'CREATE' | 'UPDATE' | 'DELETE', appUserId: number, value: object): Promise<void> {
  await tx.audit_event.create({
    data: {
      occurred_at: new Date(),
      target_type_code: AUDIT_TARGET,
      target_id: id,
      event_type_code: type,
      performed_by: BigInt(appUserId),
      ...(type === 'DELETE' ? { before_value: value } : { after_value: value }),
    },
  });
}

function num(value: unknown): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function optional(column: 'warehouse_id' | 'item_id' | 'source_warehouse_id', value: unknown): Prisma.replenishment_itemWhereInput {
  const id = num(value);
  return id === undefined ? {} : { [column]: id };
}
