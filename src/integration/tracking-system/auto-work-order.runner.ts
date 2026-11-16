import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { isAutoWorkOrderPlant } from '../../app/policy/plant-policy-text';
import { ContractException } from '../../common/errors';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncLease } from '../erp/sync-lease';
import { AutoWorkOrderService } from './auto-work-order.service';

export const AUTO_WORK_ORDER_LEASE = 'auto-work-order';
/** 5분 주기 — flowtrack 이 MES W/O 목록을 5분마다 읽는다(제안 §2). ERP W/O 는 15분마다 들어온다. */
export const TICK_MS = 5 * 60_000;
/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다(다른 실행기와 같다). */
export const STARTUP_DELAY_MS = 10_000;
export const BATCH_SIZE = 20;
/** 실패한 ERP W/O 는 이 간격 뒤에 다시 고른다 — 회차마다 같은 실패로 채번·로그를 쌓지 않는다. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** 리스 연장 간격 — TTL(120초)보다 넉넉히 짧게. */
export const LEASE_EXTEND_MS = 30_000;

class Stopping extends Error {}

/**
 * OA 자동 W/O 실행기(사용자 결정 2026-11-16) — 오늘 자동 라우팅 공정 정책이 걸린 공장의 ERP W/O 를 한 건씩
 * `AutoWorkOrderService` 로 끌고 간다. 고르는 것은 사람이 세운 계획이 없고 자동 흐름이 할 일이 남은 ERP W/O 다 —
 * 계획 없음 · 작성중 자동 계획 · 배포 전 W/O. 실패는 그 ERP W/O 의 `auto_work_order_*` 에 남기고 10분 뒤 다시 고른다.
 * 「한 대만」은 리스가 지킨다. 시각은 `tick(now)` 로만 받는다 — 검사가 시각을 움직인다.
 */
export class AutoWorkOrderRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AutoWorkOrderRunner.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private leaseExtendedAt = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly prisma: PrismaService,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release'>,
    private readonly auto: Pick<AutoWorkOrderService, 'run'>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule(STARTUP_DELAY_MS);
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
        .catch((error: unknown) => this.logger.warn(`OA 자동 W/O 회차 실패 — ${messageOf(error)}`))
        .finally(() => {
          this.running = undefined;
          this.schedule(TICK_MS);
        });
    }, delayMs);
  }

  /** 한 회차. 끝까지 처리한 ERP W/O 수를 낸다. 검사는 이것을 직접 부른다. */
  async tick(now: Date = new Date()): Promise<number> {
    if (!(await this.lease.acquire().catch(() => false))) return 0;
    this.leaseExtendedAt = Date.now();
    let done = 0;
    try {
      for (const plantId of await this.plants(now)) done += await this.runPlant(plantId, now);
    } catch (error) {
      if (!(error instanceof Stopping)) throw error;
    }
    return done;
  }

  /** 오늘(공장 현지) 자동 라우팅 공정 정책이 걸린 공장 — 정책이 곧 대상 공장이다. */
  private async plants(now: Date): Promise<bigint[]> {
    const rows = await this.prisma.operation_policy.findMany({
      where: { policy_code: 'AUTO_ROUTING_PROCESS', plant_id: { not: null } },
      select: { plant_id: true, plant: { select: { timezone_code: true } } },
      distinct: ['plant_id'],
    });
    const plants: bigint[] = [];
    for (const { plant_id: plantId, plant } of rows) {
      if (plantId === null || plant === null) continue;
      const today = localDate(now, plant.timezone_code);
      if (await isAutoWorkOrderPlant(this.prisma, plantId, today)) plants.push(plantId);
    }
    return plants;
  }

  private async runPlant(plantId: bigint, now: Date): Promise<number> {
    let done = 0;
    // 이 회차에 이미 손댄 ERP W/O 는 다시 고르지 않는다 — 실패 기록마저 실패해도 다음 묶음으로 넘어간다.
    const tried: bigint[] = [];
    for (;;) {
      const due = await this.due(plantId, now, tried);
      if (due.length === 0) return done;
      for (const orderId of due) {
        if (this.stopping) throw new Stopping();
        await this.keepLease();
        tried.push(orderId);
        if (await this.runOne(orderId, now)) done += 1;
      }
    }
  }

  /** 30초마다 리스를 늘린다 — 남이 가져갔으면 이 회차를 접는다. */
  private async keepLease(): Promise<void> {
    if (Date.now() - this.leaseExtendedAt < LEASE_EXTEND_MS) return;
    if (!(await this.lease.acquire().catch(() => false))) throw new Stopping();
    this.leaseExtendedAt = Date.now();
  }

  private async due(plantId: bigint, now: Date, tried: bigint[]): Promise<bigint[]> {
    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);
    const rows = await this.prisma.$queryRaw<{ id: bigint }[]>`
      SELECT o.production_order_id AS id
        FROM planning.production_order o
       WHERE o.plant_id = ${plantId}
         AND o.status_code <> 'CANCELLED'
         AND NOT EXISTS (SELECT 1 FROM planning.production_plan p
                          WHERE p.production_order_id = o.production_order_id AND NOT p.created_automatically)
         AND (NOT EXISTS (SELECT 1 FROM planning.production_plan p WHERE p.production_order_id = o.production_order_id)
              OR EXISTS (SELECT 1 FROM planning.production_plan p
                          WHERE p.production_order_id = o.production_order_id AND p.status_code = 'DRAFT')
              OR EXISTS (SELECT 1 FROM production.work_order w
                           JOIN planning.production_plan p ON p.production_plan_id = w.production_plan_id
                          WHERE p.production_order_id = o.production_order_id
                            AND w.released_at IS NULL AND w.status_code IN ('PLANNED', 'CONFIRMED')))
         AND (o.auto_work_order_error_text IS NULL OR o.auto_work_order_attempted_at < ${retryBefore})
         AND NOT (o.production_order_id = ANY(${tried}::bigint[]))
       ORDER BY o.planned_start_date NULLS LAST, o.production_order_id
       LIMIT ${BATCH_SIZE}`;
    return rows.map((row) => row.id);
  }

  private async runOne(orderId: bigint, now: Date): Promise<boolean> {
    let error: string | null = null;
    try {
      await this.auto.run(orderId, now);
    } catch (thrown) {
      error = messageOf(thrown).slice(0, 1000);
      this.logger.warn(`OA 자동 W/O 실패 — ERP W/O ${orderId}: ${error}`);
    }
    await this.prisma.production_order
      .update({
        where: { production_order_id: orderId },
        data: { auto_work_order_attempted_at: now, auto_work_order_error_text: error },
      })
      .catch((recordError: unknown) => this.logger.warn(`OA 자동 W/O 기록 실패 — ${messageOf(recordError)}`));
    return error === null;
  }
}

/** 계약 오류는 화면이 읽는 문구를 모은다 — 사람이 ERP W/O 에서 까닭을 읽는다. */
function messageOf(error: unknown): string {
  if (error instanceof ContractException) return error.errors.map((item) => item.message).join(' · ');
  return error instanceof Error ? error.message : String(error);
}
