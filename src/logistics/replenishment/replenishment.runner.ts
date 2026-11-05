import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { plantReplenishmentRunTime } from '../../app/policy/replenishment-run-time';
import { arrivalLocationId, plantProductionWarehouses } from '../../core/material-issue/production-warehouse';
import { ReplenishmentCreator, ReplenishmentLine, sourceGroups } from '../../core/material-issue/replenishment-create';
import { lockPairs, pairKey } from '../../core/material-issue/planned-stock';
import { replenishmentStock } from '../../core/material-issue/replenishment-stock';
import { NumberingService } from '../../core/numbering';
import { SyncLease } from '../../integration/erp/sync-lease';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { holdZaloUntil } from '../material-issue-request/material-issue-release.runner';
import { RunLineResult, createdResult, decide, isDue, localClock } from './replenishment-plan';

export const REPLENISHMENT_LEASE = 'production-warehouse-replenishment';
/** 60초 주기 — 실행 시각 뒤 1분 안에 돈다. 003 배포 러너와 같은 골격이다. */
export const REPLENISHMENT_TICK_MS = 60_000;
/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다. */
export const REPLENISHMENT_STARTUP_DELAY_MS = 10_000;
/** 리스 연장 간격 — TTL(120초)보다 넉넉히 짧게(003 배포 러너와 같다). */
const LEASE_EXTEND_MS = 30_000;

interface RunLineRow {
  itemId: bigint;
  resultCode: RunLineResult;
  usableQty: Prisma.Decimal;
  requestedQty: Prisma.Decimal;
  shortageQty: Prisma.Decimal;
  requestId: bigint | null;
}

/**
 * 자동 보충 러너(피처 004 · US5 · research R-10). 회차마다 공장 현지 날짜·시각을 구해, 실행 시각이 지났고 오늘 기록이
 * 없는 생산 창고를 처리한다. 창고마다 한 트랜잭션 — 실행 기록(UNIQUE(창고, 날짜))·요청·결과 줄을 함께 넣어, 두 러너가
 * 같이 돌아도 UNIQUE 가 하나만 남기고(SC-005), 재시작 뒤 같은 날은 기록이 있어 다시 돌지 않으며 지난날은 보지 않는다(FR-034).
 * 창고 단위 실패는 별도 트랜잭션으로 `FAILED` 를 남기고 다음 창고로 간다 — 그날은 다시 돌지 않는다(plan 확인할 것 6).
 * 시각은 `tick(now)` 로만 받는다 — 검사가 시각을 움직인다.
 */
export class ReplenishmentRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReplenishmentRunner.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private leaseExtendedAt = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly prisma: PrismaService,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release'>,
    private readonly creator: Pick<ReplenishmentCreator, 'write'>,
    private readonly numbering: Pick<NumberingService, 'nextMany'>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule(REPLENISHMENT_STARTUP_DELAY_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
    if (!this.enabled) return;
    await this.lease.release().catch((error: unknown) => this.logger.warn(`리스 반납 실패 — ${messageOf(error)}`));
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.warn(`자동 보충 회차 실패 — ${messageOf(error)}`))
        .finally(() => {
          this.running = undefined;
          this.schedule(REPLENISHMENT_TICK_MS);
        });
    }, delayMs);
  }

  /** 한 회차. 실행한 창고 수를 낸다(성공·실패 모두). 검사는 이것을 직접 부른다. */
  async tick(now: Date = new Date()): Promise<number> {
    if (!(await this.lease.acquire().catch(() => false))) return 0;
    this.leaseExtendedAt = Date.now();
    const plants = await this.prisma.plant.findMany({ where: { is_active: true }, select: { plant_id: true, timezone_code: true } });
    let ran = 0;
    for (const plant of plants) {
      if (this.stopping) break;
      ran += await this.runPlant(plant.plant_id, plant.timezone_code, now);
    }
    return ran;
  }

  private async runPlant(plantId: bigint, timezone: string, now: Date): Promise<number> {
    const warehouseIds = await plantProductionWarehouses(this.prisma, plantId);
    if (warehouseIds.length === 0) return 0;
    const today = localDate(now, timezone);
    const clock = localClock(now, timezone);
    const [plantDefault, settings, runs] = await Promise.all([
      plantReplenishmentRunTime(this.prisma, plantId, today),
      this.prisma.replenishment_warehouse_setting.findMany({ where: { warehouse_id: { in: warehouseIds } } }),
      this.prisma.replenishment_run.findMany({ where: { warehouse_id: { in: warehouseIds }, run_date: dateOf(today) }, select: { warehouse_id: true } }),
    ]);
    const runTimeOf = new Map(settings.map((s) => [s.warehouse_id, s.run_time]));
    const ranToday = new Set(runs.map((r) => r.warehouse_id));
    let ran = 0;
    for (const warehouseId of warehouseIds) {
      if (this.stopping) break;
      if (!isDue(clock, runTimeOf.get(warehouseId) ?? plantDefault.runTime, ranToday.has(warehouseId))) continue;
      // 30초마다 리스를 늘린다 — 남이 가져갔으면 이 회차를 접는다(다른 인스턴스가 이어 돈다).
      if (!(await this.keepLease())) break;
      if (await this.runWarehouse(plantId, warehouseId, today, now)) ran += 1;
    }
    return ran;
  }

  private async keepLease(): Promise<boolean> {
    if (Date.now() - this.leaseExtendedAt < LEASE_EXTEND_MS) return true;
    if (!(await this.lease.acquire().catch(() => false))) return false;
    this.leaseExtendedAt = Date.now();
    return true;
  }

  /** 창고 하나. 기록을 남겼으면 참(실패 기록 포함), 다른 러너가 먼저 돌았으면 거짓. */
  private async runWarehouse(plantId: bigint, warehouseId: bigint, today: string, now: Date): Promise<boolean> {
    try {
      const items = await this.prisma.replenishment_item.findMany({
        where: { warehouse_id: warehouseId },
        select: { source_warehouse_id: true },
      });
      // ⛔ 번호는 트랜잭션 «밖»에서 — 출고 자재 창고 수만큼(상한). 쓰지 않으면 결번이다.
      const reserved = sortedUnique(items.map((i) => i.source_warehouse_id));
      const count = reserved.length;
      const [requestNos, pickingNos] =
        count === 0
          ? [[], []]
          : await Promise.all([
              this.numbering.nextMany('MATERIAL_ISSUE_REQUEST', plantId, today, count),
              this.numbering.nextMany('PICKING_ORDER', plantId, today, count),
            ]);
      await this.prisma.$transaction((tx) => this.write(tx, warehouseId, today, now, { reserved, requestNos, pickingNos }));
      return true;
    } catch (error) {
      // 같은 (창고, 날짜) 기록이 이미 있다 — 다른 러너가 먼저 돌았다. 건너뛴다.
      if (isUniqueViolation(error)) return false;
      const message = messageOf(error).slice(0, 1000);
      this.logger.warn(`자동 보충 실패 — 창고 ${warehouseId}: ${message}`);
      await this.prisma.replenishment_run
        .createMany({
          data: [{ warehouse_id: warehouseId, run_date: dateOf(today), started_at: now, finished_at: now, status_code: 'FAILED', error_text: message }],
          skipDuplicates: true,
        })
        .catch((recordError: unknown) => this.logger.warn(`자동 보충 실패 기록 실패 — ${messageOf(recordError)}`));
      return true;
    }
  }

  private async write(
    tx: Prisma.TransactionClient,
    warehouseId: bigint,
    today: string,
    now: Date,
    numbers: Reserved,
  ): Promise<void> {
    // 기록을 먼저 넣는다 — 두 번째 러너는 여기서 UNIQUE 에 걸려 트랜잭션째 물러난다.
    const run = await tx.replenishment_run.create({
      data: { warehouse_id: warehouseId, run_date: dateOf(today), started_at: now, status_code: 'DONE' },
      select: { replenishment_run_id: true },
    });
    const { items, lines, requested } = await decideItems(tx, warehouseId);
    let createdCount = 0;
    if (requested.length > 0) {
      const zaloNotBefore = holdZaloUntil(now);
      const created = await this.creator.write(
        tx,
        {
          productionWarehouseId: warehouseId,
          destinationLocationId: await arrivalLocationId(tx, warehouseId),
          issueWorkDate: today,
          origin: 'AUTO',
          runId: run.replenishment_run_id,
          lines: requested,
          actorId: null,
          now,
          ...(zaloNotBefore === undefined ? {} : { zaloNotBefore }),
        },
        alignNumbers(numbers, sourceGroups(requested)),
      );
      createdCount = created.requests.length;
      const usableOf = new Map(requested.map((r) => [r.itemId, r.usable]));
      for (const request of created.requests) {
        for (const row of request.lines) {
          lines.push({
            itemId: row.line.itemId,
            resultCode: createdResult(row.requested, row.shortage),
            usableQty: usableOf.get(row.line.itemId) as Prisma.Decimal,
            requestedQty: row.requested,
            shortageQty: row.shortage,
            requestId: request.requestId,
          });
        }
      }
      for (const row of created.skippedLines) {
        lines.push({ ...skipped(row.line.itemId, 'NO_SOURCE_STOCK', usableOf.get(row.line.itemId) as Prisma.Decimal), shortageQty: row.line.requestedQty });
      }
    }
    if (lines.length > 0) {
      await tx.replenishment_run_line.createMany({
        data: lines.map((l) => ({
          replenishment_run_id: run.replenishment_run_id,
          item_id: l.itemId,
          result_code: l.resultCode,
          usable_qty: l.usableQty,
          requested_qty: l.requestedQty,
          shortage_qty: l.shortageQty,
          material_issue_request_id: l.requestId,
        })),
      });
    }
    await tx.replenishment_run.update({
      where: { replenishment_run_id: run.replenishment_run_id },
      data: { finished_at: now, checked_item_count: items.length, created_request_count: createdCount },
    });
  }
}

/**
 * 관리 품목마다 판단 — 건너뛴 품목은 결과 줄, 보충할 품목은 요청 줄. (출고 자재 창고, 품목) 쌍을 먼저 잠근다 —
 * 직접 요청도 같은 쌍을 잠그므로 「진행 중 보충 없음」을 읽은 뒤 직접 요청이 끼어들지 못한다(SC-004).
 */
async function decideItems(tx: Prisma.TransactionClient, warehouseId: bigint) {
  const items = await tx.replenishment_item.findMany({
    where: { warehouse_id: warehouseId },
    include: { item: { select: { base_uom_id: true } }, source_warehouse: { select: { is_active: true } } },
    orderBy: { item_id: 'asc' },
  });
  await lockPairs(tx, items.map((i) => ({ warehouseId: i.source_warehouse_id, itemId: i.item_id })));
  const stock = await replenishmentStock(tx, items.map((i) => ({ warehouseId, itemId: i.item_id })));
  const lines: RunLineRow[] = [];
  const requested: (ReplenishmentLine & { usable: Prisma.Decimal })[] = [];
  for (const item of items) {
    const s = stock.get(pairKey(warehouseId, item.item_id));
    const usable = s?.usableQty ?? new Prisma.Decimal(0);
    const decision = decide({
      itemId: item.item_id,
      reorderPointQty: item.reorder_point_qty,
      targetQty: item.target_qty,
      usableQty: usable,
      inProgressRequestCount: s?.inProgressRequestCount ?? 0,
      sourceActive: item.source_warehouse.is_active,
    });
    if (decision.kind === 'SKIP') lines.push(skipped(item.item_id, decision.result, usable));
    if (decision.kind === 'REQUEST') {
      requested.push({ itemId: item.item_id, uomId: item.item.base_uom_id, requestedQty: decision.qty, sourceWarehouseId: item.source_warehouse_id, usable });
    }
  }
  return { items, lines, requested };
}

function skipped(itemId: bigint, resultCode: RunLineResult, usable: Prisma.Decimal): RunLineRow {
  const zero = new Prisma.Decimal(0);
  return { itemId, resultCode, usableQty: usable, requestedQty: zero, shortageQty: zero, requestId: null };
}

/** 트랜잭션 밖에서 받은 번호 — 그때 관리 품목의 출고 자재 창고(정렬)마다 한 쌍. */
interface Reserved {
  reserved: bigint[];
  requestNos: string[];
  pickingNos: string[];
}

function sortedUnique(ids: bigint[]): bigint[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 번호는 채번 때의 출고 자재 창고 목록 기준이다 — 실제 요청 묶음(`sourceGroups`)의 순서에 맞춰 고른다.
 * 생성 함수는 묶음 순서의 index 로 번호를 쓴다.
 */
function alignNumbers(numbers: Reserved, groups: bigint[]): { requestNos: string[]; pickingNos: string[] } {
  const index = groups.map((g) => numbers.reserved.indexOf(g));
  // 채번 뒤 관리 품목이 바뀌어 새 출고 자재 창고가 생겼다 — 번호 없이 만들지 않는다(그 창고는 실패로 남고 다음 날 돈다).
  if (index.includes(-1)) throw new Error('채번 뒤 관리 품목의 출고 자재 창고가 바뀌었다');
  return { requestNos: index.map((i) => numbers.requestNos[i]), pickingNos: index.map((i) => numbers.pickingNos[i]) };
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** 실행 기록 UNIQUE(창고, 날짜) 위반만 — 다른 유일 위반(번호 등)은 실패로 남긴다. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const columns = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  return columns.includes('run_date') || columns.some((c) => c.includes('uq_replenishment_run_warehouse_date'));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
