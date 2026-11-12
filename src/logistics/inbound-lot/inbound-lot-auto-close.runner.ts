import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { INBOUND_LOT_RECEIVING } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { SyncLease } from '../../integration/erp/sync-lease';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundLotCloseService, IqcRequestNoNeeded, iqcRecordOf } from './inbound-lot-close';

export const INBOUND_LOT_AUTO_CLOSE_LEASE = 'inbound-lot-auto-close';
/** 60초 주기 — 공장 현지 0시가 지난 뒤 처음 회차에 닫는다(서버가 내려가 있었어도 따라잡는다). */
export const INBOUND_LOT_AUTO_CLOSE_TICK_MS = 60_000;
/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다. */
export const INBOUND_LOT_AUTO_CLOSE_STARTUP_DELAY_MS = 10_000;
/** 리스 연장 간격 — TTL(120초)보다 넉넉히 짧게(보충 러너와 같다). */
const LEASE_EXTEND_MS = 30_000;
const RETRY = 3;
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

interface StaleInboundLot {
  inbound_lot_id: bigint;
  plant_id: bigint;
  item_id: bigint;
  inbound_receipt_line: { inspection_required: boolean };
}

/**
 * 날짜 자동 마감 러너(피처 005 · research R-21). 회차마다 공장 현지 오늘을 구해 `open_since_date` 가 그보다 앞인 입하 중
 * 입하 LOT 을 건마다 한 트랜잭션으로 시스템이 마감한다 — 수동 `:close-receipt` 와 같은 코어(R-5a). 한 건 실패는 로그만 남기고
 * 다음 건으로 가며, 그 건은 다음 회차에 다시 한다. 시각은 `tick(now)` 로만 받는다 — 검사가 시각을 움직인다.
 */
export class InboundLotAutoCloseRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InboundLotAutoCloseRunner.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private leaseExtendedAt = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly prisma: PrismaService,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release'>,
    private readonly closer: Pick<InboundLotCloseService, 'closeInboundLot'>,
    private readonly numbering: Pick<NumberingService, 'next'>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule(INBOUND_LOT_AUTO_CLOSE_STARTUP_DELAY_MS);
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
        .catch((error: unknown) => this.logger.warn(`날짜 자동 마감 회차 실패 — ${messageOf(error)}`))
        .finally(() => {
          this.running = undefined;
          this.schedule(INBOUND_LOT_AUTO_CLOSE_TICK_MS);
        });
    }, delayMs);
  }

  /** 한 회차. 닫은 입하 LOT 수를 낸다. 검사는 이것을 직접 부른다. */
  async tick(now: Date = new Date()): Promise<number> {
    if (!(await this.lease.acquire().catch(() => false))) return 0;
    this.leaseExtendedAt = Date.now();
    const plants = await this.prisma.plant.findMany({ select: { plant_id: true, timezone_code: true }, orderBy: { plant_id: 'asc' } });
    let closed = 0;
    for (const plant of plants) {
      if (this.stopping) break;
      const today = localDate(now, plant.timezone_code);
      // 색인 ix_inbound_lot_auto_close(open_since_date) WHERE status_code = 'RECEIVING' 을 탄다.
      const stale = await this.prisma.inbound_lot.findMany({
        where: { plant_id: plant.plant_id, status_code: INBOUND_LOT_RECEIVING, open_since_date: { lt: dateOf(today) } },
        select: { inbound_lot_id: true, plant_id: true, item_id: true, inbound_receipt_line: { select: { inspection_required: true } } },
        orderBy: { inbound_lot_id: 'asc' },
      });
      for (const lot of stale) {
        if (this.stopping || !(await this.keepLease())) return closed;
        if (await this.closeOne(lot, today, now)) closed += 1;
      }
    }
    return closed;
  }

  private async keepLease(): Promise<boolean> {
    if (Date.now() - this.leaseExtendedAt < LEASE_EXTEND_MS) return true;
    if (!(await this.lease.acquire().catch(() => false))) return false;
    this.leaseExtendedAt = Date.now();
    return true;
  }

  /** 한 건. 닫았으면 참 — 그사이 사람이 닫거나 마감 취소로 오늘 다시 열렸으면 거짓. */
  private async closeOne(lot: StaleInboundLot, today: string, now: Date): Promise<boolean> {
    try {
      // ⛔ IQC 요청 번호는 트랜잭션 «밖»에서(`close()`·받기와 같다). 쓰지 않으면 결번이다.
      const needsNo = (await iqcRecordOf(this.prisma as unknown as Prisma.TransactionClient, lot.item_id, lot.inbound_receipt_line.inspection_required, today)) !== null;
      let iqcRequestNo = needsNo ? await this.numbering.next('INSPECTION_REQUEST', lot.plant_id, today) : null;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.prisma.$transaction(async (tx) => {
            if (!(await lockStillStale(tx, lot.inbound_lot_id, today))) return false;
            await this.closer.closeInboundLot(tx, {
              inboundLotId: lot.inbound_lot_id, actor: null, auto: true, at: now, effectiveDate: today, iqcRequestNo,
            });
            return true;
          }, TRANSACTION_OPTIONS);
        } catch (error) {
          if (attempt >= RETRY || !(error instanceof IqcRequestNoNeeded)) throw error;
          iqcRequestNo = await this.numbering.next('INSPECTION_REQUEST', lot.plant_id, today);
        }
      }
    } catch (error) {
      this.logger.warn(`날짜 자동 마감 실패 — 입하 LOT ${String(lot.inbound_lot_id)}: ${messageOf(error).slice(0, 1000)}`);
      return false;
    }
  }
}

/**
 * 잠그고 다시 본다. `NOWAIT` — 받기·마감이 잡고 있으면 기다리지 않고 이 건을 실패로 넘긴다(다음 회차에 다시). 받기는 같은
 * 트랜잭션에서 지난 날짜 입하 LOT 을 스스로 자동 마감한다(R-21).
 */
async function lockStillStale(tx: Prisma.TransactionClient, inboundLotId: bigint, today: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ inbound_lot_id: bigint }[]>`
    SELECT inbound_lot_id
      FROM trace.inbound_lot
     WHERE inbound_lot_id = ${inboundLotId} AND status_code = ${INBOUND_LOT_RECEIVING} AND open_since_date < ${today}::date
       FOR UPDATE NOWAIT`;
  return rows.length === 1;
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
