import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { InventoryCountQueryService } from './inventory-count-query.service';
import { snapshotOf } from './inventory-count-create.service';
import { InventoryCountLineView } from './inventory-count-view';

export interface InventoryCountLineReplace {
  locationId: number;
  businessDate: string;
  occurredAt: string;
  lines: InventoryCountLineUpsert[];
}

export interface InventoryCountLineUpsert {
  inventoryCountLineId?: number;
  locationId: number;
  itemId: number;
  lotId?: number | null;
  countedQty: number;
  uomId: number;
  varianceReasonCode?: string | null;
  countedAt: string;
}

export interface InventoryCountUpdateContext {
  appUserId: number;
  workerNo?: string;
  version?: number;
}

interface LockedCount {
  inventory_count_id: bigint;
  warehouse_id: bigint;
  status_code: string;
  version_no: number;
}

type ExistingLine = Prisma.inventory_count_lineGetPayload<object>;
const VARIANCE_REASON = 'VARIANCE_REASON';

@Injectable()
export class InventoryCountUpdateService {
  constructor(private readonly queries: InventoryCountQueryService) {}

  async replaceWithin(
    tx: Prisma.TransactionClient,
    inventoryCountId: number,
    input: InventoryCountLineReplace,
    context: InventoryCountUpdateContext,
  ): Promise<PagedResponse<InventoryCountLineView>> {
    assertMoments(input);
    assertRequestDimensions(input);
    const count = await lockCount(tx, inventoryCountId, context.version);
    assertWritableStatus(count.status_code);
    await assertLocation(tx, input.locationId, count.warehouse_id);
    const existing = await tx.inventory_count_line.findMany({
      where: {
        inventory_count_id: count.inventory_count_id,
        location_id: BigInt(input.locationId),
      },
      orderBy: [{ line_no: 'asc' }, { inventory_count_line_id: 'asc' }],
    });
    const countedBy = await countedByOf(tx, context);
    await assertReferences(tx, input.lines);
    const snapshot = input.lines.some((line) => line.inventoryCountLineId === undefined)
      ? await snapshotOf(tx, count.warehouse_id)
      : [];
    const prepared = prepareLines(existing, input.lines, snapshot, countedBy, context.appUserId);
    await assertCodeValues(tx, prepared.codeChecks);

    if (prepared.omittedIds.length > 0) {
      await tx.inventory_count_line.updateMany({
        where: { inventory_count_line_id: { in: prepared.omittedIds } },
        data: {
          counted: false,
          counted_qty: 0,
          variance_reason_code: null,
          counted_by: null,
        },
      });
    }
    for (const update of prepared.updates) {
      await tx.inventory_count_line.update({
        where: { inventory_count_line_id: update.inventoryCountLineId },
        data: update.data,
      });
    }
    if (prepared.creates.length > 0) {
      const last = await tx.inventory_count_line.aggregate({
        where: { inventory_count_id: count.inventory_count_id },
        _max: { line_no: true },
      });
      const firstLineNo = (last._max.line_no ?? 0) + 1;
      await tx.inventory_count_line.createMany({
        data: prepared.creates.map((line, index) => ({
          ...line,
          inventory_count_id: count.inventory_count_id,
          line_no: firstLineNo + index,
        })),
      });
    }

    const moved = await tx.inventory_count.updateMany({
      where: {
        inventory_count_id: count.inventory_count_id,
        version_no: count.version_no,
      },
      data: {
        status_code: count.status_code === 'PLANNED' ? 'IN_PROGRESS' : count.status_code,
        version_no: { increment: 1 },
        updated_by: context.appUserId,
      },
    });
    assertUpdated(moved.count);
    return this.queries.linesWithin(tx, inventoryCountId, { locationId: input.locationId });
  }
}

async function lockCount(
  tx: Prisma.TransactionClient,
  inventoryCountId: number,
  version: number | undefined,
): Promise<LockedCount> {
  const rows = await tx.$queryRaw<LockedCount[]>`
    SELECT inventory_count_id, warehouse_id, status_code, version_no
      FROM inventory.inventory_count
     WHERE inventory_count_id = ${BigInt(inventoryCountId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 재고 실사입니다.');
  if (version !== undefined && rows[0].version_no !== version) assertUpdated(0);
  return rows[0];
}

function assertWritableStatus(statusCode: string): void {
  if (statusCode === 'PLANNED' || statusCode === 'IN_PROGRESS') return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('inventoryCountId', ERROR_CODE.STATE_LOCKED, '진행 중인 실사만 입력할 수 있습니다.'),
  ]);
}

async function assertLocation(
  tx: Prisma.TransactionClient,
  locationId: number,
  warehouseId: bigint,
): Promise<void> {
  const location = await tx.location.findUnique({
    where: { location_id: locationId },
    select: { warehouse_id: true },
  });
  if (location === null || location.warehouse_id !== warehouseId) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('locationId', ERROR_CODE.INVALID, '실사 창고에 속한 위치가 아닙니다.'),
    ]);
  }
}

async function countedByOf(
  tx: Prisma.TransactionClient,
  context: InventoryCountUpdateContext,
): Promise<bigint | null> {
  if (context.workerNo === undefined) return BigInt(context.appUserId);
  const worker = await tx.worker.findUnique({
    where: { worker_no: context.workerNo },
    select: { app_user_id: true },
  });
  if (worker === null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'),
    ]);
  }
  return worker.app_user_id;
}

async function assertReferences(
  tx: Prisma.TransactionClient,
  lines: InventoryCountLineUpsert[],
): Promise<void> {
  const itemIds = [...new Set(lines.map((line) => line.itemId))];
  const lotIds = [...new Set(lines.flatMap((line) => (line.lotId == null ? [] : [line.lotId])))];
  const uomIds = [...new Set(lines.map((line) => line.uomId))];
  const [items, lots, uoms] = await Promise.all([
    tx.item.findMany({ where: { item_id: { in: itemIds } }, select: { item_id: true } }),
    tx.lot.findMany({
      where: { lot_id: { in: lotIds } },
      select: { lot_id: true, item_id: true },
    }),
    tx.uom.findMany({ where: { uom_id: { in: uomIds } }, select: { uom_id: true } }),
  ]);
  const knownItems = new Set(items.map((row) => Number(row.item_id)));
  const knownLots = new Map(lots.map((row) => [Number(row.lot_id), Number(row.item_id)]));
  const knownUoms = new Set(uoms.map((row) => Number(row.uom_id)));
  const errors: ErrorItem[] = [];
  lines.forEach((line, index) => {
    if (!knownItems.has(line.itemId)) {
      errors.push(field(`lines.${index}.itemId`, ERROR_CODE.INVALID, '없는 품목입니다.'));
    }
    if (line.lotId != null && knownLots.get(line.lotId) !== line.itemId) {
      errors.push(field(`lines.${index}.lotId`, ERROR_CODE.INVALID, '품목에 속한 LOT이 아닙니다.'));
    }
    if (!knownUoms.has(line.uomId)) {
      errors.push(field(`lines.${index}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
    }
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

interface PreparedLines {
  omittedIds: bigint[];
  updates: {
    inventoryCountLineId: bigint;
    data: Prisma.inventory_count_lineUpdateInput;
  }[];
  creates: Omit<
    Prisma.inventory_count_lineCreateManyInput,
    'inventory_count_id' | 'line_no'
  >[];
  codeChecks: { field: string; value: string; groupCode: string }[];
}

function prepareLines(
  existing: ExistingLine[],
  input: InventoryCountLineUpsert[],
  snapshot: Awaited<ReturnType<typeof snapshotOf>>,
  countedBy: bigint | null,
  appUserId: number,
): PreparedLines {
  const byId = new Map(existing.map((line) => [Number(line.inventory_count_line_id), line]));
  const suppliedIds = new Set(
    input.flatMap((line) =>
      line.inventoryCountLineId === undefined ? [] : [line.inventoryCountLineId],
    ),
  );
  const snapshotByDimension = new Map(
    snapshot.map((line) => [
      dimensionKey(Number(line.location_id), Number(line.item_id), line.lot_id, Number(line.uom_id)),
      line.system_qty,
    ]),
  );
  const errors: ErrorItem[] = [];
  const codeChecks: PreparedLines['codeChecks'] = [];
  const updates: PreparedLines['updates'] = [];
  const creates: PreparedLines['creates'] = [];

  input.forEach((line, index) => {
    const existingLine =
      line.inventoryCountLineId === undefined ? undefined : byId.get(line.inventoryCountLineId);
    if (line.inventoryCountLineId !== undefined && existingLine === undefined) {
      errors.push(
        field(
          `lines.${index}.inventoryCountLineId`,
          ERROR_CODE.INVALID,
          '이 실사와 위치에 속한 라인이 아닙니다.',
        ),
      );
      return;
    }
    if (existingLine !== undefined && !sameDimensions(existingLine, line)) {
      errors.push(
        field(
          `lines.${index}.inventoryCountLineId`,
          ERROR_CODE.INVALID,
          '기존 라인의 위치·품목·LOT·단위는 바꿀 수 없습니다.',
        ),
      );
      return;
    }
    const systemQty =
      existingLine?.system_qty ??
      snapshotByDimension.get(dimensionKey(line.locationId, line.itemId, line.lotId, line.uomId)) ??
      new Prisma.Decimal(0);
    if (systemQty.isNegative()) {
      errors.push(
        field(
          `lines.${index}.inventoryCountLineId`,
          ERROR_CODE.INVALID,
          '음수 장부 라인은 질의 276 회신 전까지 추가할 수 없습니다.',
        ),
      );
      return;
    }
    const countedQty = new Prisma.Decimal(line.countedQty);
    const variance = countedQty.minus(systemQty);
    if (!variance.isZero() && !line.varianceReasonCode?.trim()) {
      errors.push(
        field(
          `lines.${index}.varianceReasonCode`,
          ERROR_CODE.REQUIRED,
          '장부와 실물 수량이 다르면 차이 사유가 필요합니다.',
        ),
      );
    } else if (variance.isZero() && line.varianceReasonCode != null) {
      errors.push(
        field(
          `lines.${index}.varianceReasonCode`,
          ERROR_CODE.INVALID,
          '차이가 없으면 차이 사유를 보내지 않습니다.',
        ),
      );
    } else if (line.varianceReasonCode != null) {
      codeChecks.push({
        field: `lines.${index}.varianceReasonCode`,
        value: line.varianceReasonCode,
        groupCode: VARIANCE_REASON,
      });
    }
    const data = {
      counted_qty: countedQty,
      variance_reason_code: line.varianceReasonCode ?? null,
      counted_by: countedBy,
      counted_at: new Date(line.countedAt),
      counted: true,
    };
    if (existingLine !== undefined) {
      updates.push({ inventoryCountLineId: existingLine.inventory_count_line_id, data });
    } else {
      creates.push({
        location_id: line.locationId,
        item_id: line.itemId,
        lot_id: line.lotId ?? null,
        system_qty: systemQty,
        uom_id: line.uomId,
        created_by: appUserId,
        ...data,
      });
    }
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return {
    omittedIds: existing
      .filter((line) => !suppliedIds.has(Number(line.inventory_count_line_id)))
      .map((line) => line.inventory_count_line_id),
    updates,
    creates,
    codeChecks,
  };
}

function assertMoments(input: InventoryCountLineReplace): void {
  const errors: ErrorItem[] = [];
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
    Number.isNaN(Date.parse(`${input.businessDate}T00:00:00Z`))
  ) {
    errors.push(
      field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'),
    );
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) {
    errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  input.lines.forEach((line, index) => {
    if (Number.isNaN(Date.parse(line.countedAt))) {
      errors.push(field(`lines.${index}.countedAt`, ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    }
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function assertRequestDimensions(input: InventoryCountLineReplace): void {
  const keys = new Set<string>();
  const ids = new Set<number>();
  const errors: ErrorItem[] = [];
  input.lines.forEach((line, index) => {
    if (line.locationId !== input.locationId) {
      errors.push(
        field(`lines.${index}.locationId`, ERROR_CODE.INVALID, '요청 위치와 같아야 합니다.'),
      );
    }
    const key = dimensionKey(line.locationId, line.itemId, line.lotId, line.uomId);
    if (keys.has(key)) {
      errors.push(
        field(`lines.${index}`, ERROR_CODE.UNIQUE_VIOLATION, '같은 실사 차원이 중복됐습니다.'),
      );
    }
    keys.add(key);
    if (line.inventoryCountLineId !== undefined) {
      if (ids.has(line.inventoryCountLineId)) {
        errors.push(
          field(
            `lines.${index}.inventoryCountLineId`,
            ERROR_CODE.UNIQUE_VIOLATION,
            '같은 실사 라인 ID가 중복됐습니다.',
          ),
        );
      }
      ids.add(line.inventoryCountLineId);
    }
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function sameDimensions(existing: ExistingLine, input: InventoryCountLineUpsert): boolean {
  return (
    Number(existing.location_id) === input.locationId &&
    Number(existing.item_id) === input.itemId &&
    (existing.lot_id === null ? null : Number(existing.lot_id)) === (input.lotId ?? null) &&
    Number(existing.uom_id) === input.uomId
  );
}

function dimensionKey(
  locationId: number,
  itemId: number,
  lotId: bigint | number | null | undefined,
  uomId: number,
): string {
  return `${locationId} ${itemId} ${lotId === null || lotId === undefined ? 'NULL' : lotId} ${uomId}`;
}
