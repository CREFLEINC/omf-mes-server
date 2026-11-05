import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { RUN_TIME_PATTERN } from '../../app/policy/operation-policy-rules';
import { plantReplenishmentRunTime } from '../../app/policy/replenishment-run-time';
import { ERROR_CODE, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { plantProductionWarehouses } from '../../core/material-issue/production-warehouse';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { productionWarehousePlant, throwIfAny } from './replenishment-rules';

/** 계약 `ReplenishmentWarehouseSettingUpdate`. 설정 행이 아직 없는 창고는 `versionNo` 0 으로 보낸다. */
export interface ReplenishmentWarehouseSettingUpdate {
  runTime: string | null;
  versionNo: number;
}

export type WarehouseSettingView = Awaited<ReturnType<ReplenishmentSettingService['warehouseViews']>>[number];

/**
 * 자동 보충 실행 시각(W-02-12 「관리 품목」 머리 · 피처 004 · research R-10). 공장 기본은 운영 정책
 * `REPLENISHMENT_RUN_TIME`(기존 정책 경로로 저장), 창고 시각은 `replenishment_warehouse_setting`(NULL = 공장 기본).
 */
@Injectable()
export class ReplenishmentSettingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(plantId: number) {
    const plant = await this.prisma.plant.findUnique({ where: { plant_id: plantId }, select: { timezone_code: true } });
    if (plant === null) throw new NotFoundException('없는 공장입니다.');
    const plantDefault = await plantReplenishmentRunTime(this.prisma, plantId, localDate(new Date(), plant.timezone_code));
    const warehouseIds = await plantProductionWarehouses(this.prisma, BigInt(plantId));
    return {
      plantDefaultRunTime: plantDefault.runTime,
      plantDefaultSource: plantDefault.source,
      warehouses: await this.warehouseViews(this.prisma, warehouseIds, plantDefault.runTime),
    };
  }

  async update(tx: Prisma.TransactionClient, warehouseId: number, body: ReplenishmentWarehouseSettingUpdate, appUserId: number): Promise<WarehouseSettingView> {
    const id = BigInt(warehouseId);
    const plantId = await productionWarehousePlant(tx, id, 'warehouseId');
    if (body.runTime !== null && !RUN_TIME_PATTERN.test(body.runTime)) {
      throwIfAny([field('runTime', ERROR_CODE.RANGE, '실행 시각은 HH:MM(00:00~23:59)입니다.')]);
    }
    const now = new Date();
    if (body.versionNo === 0) {
      // 처음 정하는 창고 — 행이 이미 있으면(다른 사람이 먼저 정함) 저장 충돌이다.
      const created = await tx.replenishment_warehouse_setting.createMany({
        data: [{ warehouse_id: id, run_time: body.runTime, updated_at: now, updated_by: appUserId }],
        skipDuplicates: true,
      });
      assertUpdated(created.count);
    } else {
      const updated = await tx.replenishment_warehouse_setting.updateMany({
        where: { warehouse_id: id, version_no: body.versionNo },
        data: { run_time: body.runTime, updated_at: now, updated_by: appUserId, version_no: { increment: 1 } },
      });
      assertUpdated(updated.count);
    }
    const plant = await tx.plant.findUniqueOrThrow({ where: { plant_id: plantId }, select: { timezone_code: true } });
    const plantDefault = await plantReplenishmentRunTime(tx, plantId, localDate(now, plant.timezone_code));
    return (await this.warehouseViews(tx, [id], plantDefault.runTime))[0];
  }

  private async warehouseViews(db: Prisma.TransactionClient, warehouseIds: bigint[], plantDefault: string) {
    const [warehouses, settings, runs] = await Promise.all([
      db.warehouse.findMany({
        where: { warehouse_id: { in: warehouseIds } },
        select: { warehouse_id: true, warehouse_code: true, warehouse_name: true },
        orderBy: { warehouse_code: 'asc' },
      }),
      db.replenishment_warehouse_setting.findMany({ where: { warehouse_id: { in: warehouseIds } } }),
      db.replenishment_run.findMany({
        where: { warehouse_id: { in: warehouseIds } },
        orderBy: [{ run_date: 'desc' }, { replenishment_run_id: 'desc' }],
        distinct: ['warehouse_id'],
      }),
    ]);
    const settingOf = new Map(settings.map((row) => [row.warehouse_id, row]));
    const runOf = new Map(runs.map((row) => [row.warehouse_id, row]));
    return warehouses.map((warehouse) => {
      const setting = settingOf.get(warehouse.warehouse_id);
      const run = runOf.get(warehouse.warehouse_id);
      return {
        warehouseId: Number(warehouse.warehouse_id),
        warehouseCode: warehouse.warehouse_code,
        warehouseName: warehouse.warehouse_name,
        runTime: setting?.run_time ?? null,
        effectiveRunTime: setting?.run_time ?? plantDefault,
        versionNo: setting?.version_no ?? 0,
        lastRun:
          run === undefined
            ? null
            : {
                runDate: run.run_date.toISOString().slice(0, 10),
                status: run.status_code,
                finishedAt: run.finished_at?.toISOString() ?? null,
                createdRequestCount: run.created_request_count,
              },
      };
    });
  }
}
