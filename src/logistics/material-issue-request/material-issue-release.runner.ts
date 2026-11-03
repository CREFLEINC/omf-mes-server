import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { MaterialIssueReleaser } from '../../core/material-issue/release-request';
import { NumberingService } from '../../core/numbering';
import { SyncLease } from '../../integration/erp/sync-lease';
import { nextSiteMorning } from '../../integration/zalo/zalo-error-policy';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';

export const MATERIAL_ISSUE_RELEASE_LEASE = 'material-issue-release';
/** 60초 주기 — 공장 현지 00:00 뒤 5분 안에 배포한다(SC-001). 밀린 건은 다음 회차가 이어 받는다. */
export const TICK_MS = 60_000;
/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다(Zalo·ERP 러너와 같다). */
export const STARTUP_DELAY_MS = 10_000;
export const BATCH_SIZE = 20;
/** 배포에 실패한 요청은 이 간격 뒤에 다시 시도한다 — 회차마다 같은 실패로 채번·로그를 쌓지 않는다. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** 리스 연장 간격 — TTL(120초)보다 넉넉히 짧게. 건마다 늘리면 밀린 묶음에서 쓰기가 건수만큼이다(Zalo 러너와 같다). */
export const LEASE_EXTEND_MS = 30_000;
const SITE_TIMEZONE = 'Asia/Ho_Chi_Minh';

class Stopping extends Error {}

/**
 * 00:00 자동 배포(피처 003 · research R-9) — 공장마다 현지 날짜를 구해, 출고 작업일이 그날 이하인 대기 요청을
 * 한 건씩 각자의 트랜잭션으로 배포한다(FR-019). 한 건 실패가 나머지를 막지 않고, 실패는 별도 트랜잭션으로
 * `release_attempted_at`·`release_error_text` 에 남긴다(FR-022).
 *
 * 「한 대만」은 리스가, 「한 번만」은 공용 배포 함수의 행 잠금·대기 가드가 지킨다(FR-020) — 리스가 넘어가는
 * 순간 두 러너가 같은 요청을 잡아도 늦은 쪽은 대기가 아니어서 아무것도 하지 않는다.
 * 시각은 `tick(now)` 로만 받는다 — 검사가 시각을 움직인다.
 */
export class MaterialIssueReleaseRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaterialIssueReleaseRunner.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private leaseExtendedAt = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly prisma: PrismaService,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release'>,
    private readonly releaser: Pick<MaterialIssueReleaser, 'release'>,
    private readonly numbering: Pick<NumberingService, 'next'>,
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
        .catch((error: unknown) => this.logger.warn(`출고 요청 배포 회차 실패 — ${messageOf(error)}`))
        .finally(() => {
          this.running = undefined;
          this.schedule(TICK_MS);
        });
    }, delayMs);
  }

  /** 한 회차. 배포한 요청 수를 낸다. 검사는 이것을 직접 부른다. */
  async tick(now: Date = new Date()): Promise<number> {
    if (!(await this.lease.acquire().catch(() => false))) return 0;
    this.leaseExtendedAt = Date.now();
    const plants = await this.prisma.plant.findMany({ select: { plant_id: true, timezone_code: true } });
    let released = 0;
    try {
      for (const plant of plants) {
        released += await this.releasePlant(plant.plant_id, localDate(now, plant.timezone_code), now);
      }
    } catch (error) {
      if (!(error instanceof Stopping)) throw error;
    }
    return released;
  }

  private async releasePlant(plantId: bigint, today: string, now: Date): Promise<number> {
    let released = 0;
    // 이 회차에 이미 손댄 요청은 다시 고르지 않는다 — 실패 기록마저 실패해도 다음 묶음으로 넘어간다.
    const tried: bigint[] = [];
    for (;;) {
      const due = await this.due(plantId, today, now, tried);
      if (due.length === 0) return released;
      for (const requestId of due) {
        if (this.stopping) throw new Stopping();
        await this.keepLease();
        tried.push(requestId);
        if (await this.releaseOne(plantId, requestId, today, now)) released += 1;
      }
    }
  }

  /**
   * 출고 작업일이 공장 오늘 이하인 대기 요청. 공장은 출발 창고의 공장이다. 최근에 실패한 건은 간격을 둔다.
   * ⛔ 시간대 캐스팅이 없다 — 공장 오늘은 앱이 `timezone_code` 로 풀어 날짜 문자열로 넘긴다.
   */
  /** 30초마다 리스를 늘린다 — 남이 가져갔으면 이 회차를 접는다. */
  private async keepLease(): Promise<void> {
    if (Date.now() - this.leaseExtendedAt < LEASE_EXTEND_MS) return;
    if (!(await this.lease.acquire().catch(() => false))) throw new Stopping();
    this.leaseExtendedAt = Date.now();
  }

  private async due(plantId: bigint, today: string, now: Date, tried: bigint[]): Promise<bigint[]> {
    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);
    const rows = await this.prisma.$queryRaw<{ id: bigint }[]>`
      SELECT r.material_issue_request_id AS id
        FROM logistics.material_issue_request r
        JOIN mdm.warehouse w ON w.warehouse_id = r.source_warehouse_id
       WHERE r.status_code = 'WAITING'
         AND w.plant_id = ${plantId}
         AND r.issue_work_date <= ${today}::date
         AND (r.release_error_text IS NULL OR r.release_attempted_at IS NULL OR r.release_attempted_at < ${retryBefore})
         AND NOT (r.material_issue_request_id = ANY(${tried}::bigint[]))
       ORDER BY r.issue_work_date, r.material_issue_request_id
       LIMIT ${BATCH_SIZE}`;
    return rows.map((row) => row.id);
  }

  private async releaseOne(plantId: bigint, requestId: bigint, today: string, now: Date): Promise<boolean> {
    try {
      // 채번은 트랜잭션 밖이다 — 쓰지 않으면(이미 배포됨·재고 없음) 결번이다.
      const pickingOrderNo = await this.numbering.next('PICKING_ORDER', plantId, today);
      const zaloNotBefore = holdZaloUntil(now);
      return await this.prisma.$transaction(
        (tx) => this.releaser.release(tx, requestId, pickingOrderNo, null, { now, ...(zaloNotBefore === undefined ? {} : { zaloNotBefore }) }),
      );
    } catch (error) {
      const message = messageOf(error).slice(0, 1000);
      this.logger.warn(`출고 요청 배포 실패 — ${requestId}: ${message}`);
      await this.prisma.material_issue_request
        .updateMany({
          where: { material_issue_request_id: requestId, status_code: 'WAITING' },
          data: { release_attempted_at: now, release_error_text: message },
        })
        .catch((recordError: unknown) => this.logger.warn(`배포 실패 기록 실패 — ${messageOf(recordError)}`));
      return false;
    }
  }
}

/**
 * 현장 07:00 전에 배포했으면 그날 07:00 까지 Zalo 를 미룬다(FR-021a). 07:00 이후면 바로 — `undefined`.
 * ⚠ `nextSiteMorning` 은 고정 UTC+7 이다(research R-18 — 지금 공장은 모두 UTC+7).
 */
export function holdZaloUntil(now: Date): Date | undefined {
  const morning = nextSiteMorning(now);
  return localDate(morning, SITE_TIMEZONE) === localDate(now, SITE_TIMEZONE) ? morning : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
