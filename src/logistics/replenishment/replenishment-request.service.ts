import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { arrivalLocationId } from '../../core/material-issue/production-warehouse';
import { ReplenishmentCreator, ReplenishmentLine, sourceGroups } from '../../core/material-issue/replenishment-create';
import { NumberingService } from '../../core/numbering';
import { PickingHandoverNotifier } from '../../core/picking';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { productionWarehousePlant, sourceWarehouseErrors, throwIfAny } from './replenishment-rules';

/** 계약 `ReplenishmentRequestCreate`. 줄의 출고 자재 창고를 비우면 관리 품목 값을 쓴다. */
export interface ReplenishmentRequestCreate {
  productionWarehouseId: number;
  businessDate: string;
  remarks?: string | null;
  lines: { itemId: number; requestedQty: number; sourceWarehouseId?: number | null }[];
}

export interface SkippedLineView {
  itemId: number;
  sourceWarehouseId: number;
  requestedQty: number;
  freeQty: number;
}

/**
 * 창고 보충 직접 요청(W-02-12 · 피처 004 · US1 · research R-3). 검증·기본값은 여기, 상한·분할·배포는
 * 코어 `ReplenishmentCreator`(자동 보충과 공용).
 */
@Injectable()
export class ReplenishmentRequestService {
  private readonly creator: ReplenishmentCreator;

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    documentState: DocumentStateService,
    pickingNotices: PickingHandoverNotifier,
  ) {
    this.creator = new ReplenishmentCreator(documentState, pickingNotices);
  }

  async create(body: ReplenishmentRequestCreate, appUserId: number): Promise<{ requestIds: bigint[]; skippedLines: SkippedLineView[] }> {
    const warehouseId = BigInt(body.productionWarehouseId);
    const plantId = await productionWarehousePlant(this.prisma, warehouseId);
    const lines = await this.resolveLines(body, warehouseId, plantId);
    const plant = await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: plantId }, select: { timezone_code: true } });
    const now = new Date();
    const destinationLocationId = await arrivalLocationId(this.prisma, warehouseId);
    // ⛔ 번호는 트랜잭션 «밖»에서 — 출고 자재 창고 수만큼. 기간 축은 클라이언트가 준 businessDate 그대로(공유계약 C-8).
    const count = sourceGroups(lines).length;
    const requestNos = await this.numbering.nextMany('MATERIAL_ISSUE_REQUEST', plantId, body.businessDate, count);
    const pickingNos = await this.numbering.nextMany('PICKING_ORDER', plantId, body.businessDate, count);
    const created = await this.prisma.$transaction(async (tx) => {
      const result = await this.creator.write(
        tx,
        {
          productionWarehouseId: warehouseId,
          destinationLocationId,
          issueWorkDate: localDate(now, plant.timezone_code),
          origin: 'DIRECT',
          lines,
          remarks: body.remarks ?? null,
          actorId: appUserId,
          now,
        },
        { requestNos, pickingNos },
      );
      if (result.requests.length === 0) {
        // 쓸 수 있는 양이 모두 0 — 다른 요청의 예정분을 가져가는 길은 없다(clarify Q2 · overridable 없음).
        throw new ContractException(
          HttpStatus.CONFLICT,
          [{ scope: 'screen', code: ERROR_CODE.PLANNED_STOCK_CONFLICT, message: '자재 창고에 보낼 수 있는 남은 수량이 없습니다.' }],
          {
            plannedStockConflicts: result.skippedLines.map(({ line }) => ({
              itemId: Number(line.itemId),
              sourceWarehouseId: Number(line.sourceWarehouseId),
              requestedQty: line.requestedQty.toNumber(),
              freeQty: 0,
              takeFromPlannedQty: 0,
              overridable: false,
              affectedRequests: [],
            })),
          },
        );
      }
      return result;
    });
    return {
      requestIds: created.requests.map((r) => r.requestId),
      skippedLines: created.skippedLines.map(({ line, freeQty }) => ({
        itemId: Number(line.itemId),
        sourceWarehouseId: Number(line.sourceWarehouseId),
        requestedQty: line.requestedQty.toNumber(),
        freeQty: freeQty.toNumber(),
      })),
    };
  }

  /** 수량·품목·출고 자재 창고(비우면 관리 품목 값)·중복 줄. 틀린 줄을 모아 한 번에 400 으로 낸다. */
  private async resolveLines(body: ReplenishmentRequestCreate, warehouseId: bigint, plantId: bigint): Promise<ReplenishmentLine[]> {
    const itemIds = [...new Set(body.lines.map((line) => BigInt(line.itemId)))];
    const [items, managed] = await Promise.all([
      this.prisma.item.findMany({ where: { item_id: { in: itemIds } }, select: { item_id: true, is_active: true, base_uom_id: true } }),
      this.prisma.replenishment_item.findMany({ where: { warehouse_id: warehouseId, item_id: { in: itemIds } }, select: { item_id: true, source_warehouse_id: true } }),
    ]);
    const itemOf = new Map(items.map((row) => [row.item_id, row]));
    const managedSource = new Map(managed.map((row) => [row.item_id, row.source_warehouse_id]));
    const errors: ErrorItem[] = [];
    const seen = new Set<string>();
    const lines: (ReplenishmentLine & { index: number })[] = [];
    body.lines.forEach((input, index) => {
      const itemId = BigInt(input.itemId);
      const item = itemOf.get(itemId);
      if (item === undefined || !item.is_active) {
        errors.push(field(`lines[${index}].itemId`, ERROR_CODE.INVALID, '사용 중인 품목이 아닙니다.'));
        return;
      }
      if (!(input.requestedQty > 0)) errors.push(field(`lines[${index}].requestedQty`, ERROR_CODE.RANGE, '요청 수량은 0 보다 커야 합니다.'));
      const source = input.sourceWarehouseId != null ? BigInt(input.sourceWarehouseId) : managedSource.get(itemId);
      if (source === undefined) {
        errors.push(field(`lines[${index}].sourceWarehouseId`, ERROR_CODE.REQUIRED, '관리 품목이 아니면 출고 자재 창고를 골라야 합니다.'));
        return;
      }
      const key = `${source}:${itemId}`;
      if (seen.has(key)) errors.push(field(`lines[${index}].itemId`, ERROR_CODE.INVALID, '같은 품목·같은 출고 자재 창고의 줄이 이미 있습니다.'));
      seen.add(key);
      lines.push({ index, itemId, uomId: item.base_uom_id, requestedQty: new Prisma.Decimal(input.requestedQty), sourceWarehouseId: source });
    });
    errors.push(
      ...(await sourceWarehouseErrors(
        this.prisma,
        { sourceWarehouseIds: lines.map((l) => l.sourceWarehouseId), productionWarehouseId: warehouseId, plantId },
        (i) => `lines[${lines[i].index}].sourceWarehouseId`,
      )),
    );
    throwIfAny(errors);
    return lines.map(({ index: _index, ...line }) => line);
  }
}
