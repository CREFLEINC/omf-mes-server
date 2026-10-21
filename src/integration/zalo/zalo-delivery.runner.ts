import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SyncLease } from '../erp/sync-lease';
import { ZaloClient } from './zalo-client';
import { ZALO_CONNECTION_ID } from './zalo-connection.service';
import { classifyZaloError, nextSiteMorning } from './zalo-error-policy';
import { ZaloAccess, ZaloTokenService } from './zalo-token.service';

export const ZALO_DELIVERY_LEASE = 'zalo-delivery';
/** 주기 10초 · 묶음 20건 — 이벤트 후 1분 안에 나간다(plan Performance Goals). */
export const TICK_MS = 10_000;
export const BATCH_SIZE = 20;
/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다(ERP 러너와 같다). */
export const STARTUP_DELAY_MS = 10_000;
/** 리스 TTL — 이보다 오래 `SENDING` 인 건은 쥔 러너가 죽은 것이다(`SyncLease` 120초). */
export const LEASE_TTL_MS = 120_000;
/** 최초 1회 + 재시도 3회 = 최대 4회 시도. 재시도 간격 1분 → 5분 → 15분(data-model §3). */
export const MAX_ATTEMPTS = 4;
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** 리스 연장 간격 — TTL(120초)보다 넉넉히 짧게. 건마다 늘리면 묶음마다 쓰기가 20번이다. */
export const LEASE_EXTEND_MS = 30_000;

type Delivery = {
  zalo_delivery_id: bigint;
  phone_number: string;
  event_type_code: string;
  template_data: Prisma.JsonValue;
  tracking_id: string;
  attempt_count: number;
};

const CONNECTION_NOT_READY = 'CONNECTION_NOT_READY';
const CONNECTION_NOT_READY_MESSAGE = 'Zalo 연결이 설정되지 않았거나 재인증이 필요합니다.';

class Stopping extends Error {}
class LeaseLost extends Error {}

/**
 * Zalo 발송 러너 — 업무 트랜잭션이 쓴 `PENDING` 건을 tx «밖»에서 보낸다(C11 · research R-8).
 * `ErpSyncRunner` 와 같은 골격이다: `setTimeout` 연쇄, 리스로 한 쪽만, 묶음마다 리스 연장, 종료 때 tick 대기.
 *
 * ⛔ `SENDING` 잔류(러너가 보낸 뒤 죽음)는 다시 보내지 않고 `FAILED UNKNOWN_OUTCOME` 으로 끝낸다 —
 * Zalo 가 이미 보냈는지 알 수 없고, 두 번 보내면 FR-026 을 어긴다. 정본은 알림센터다.
 */
export class ZaloDeliveryRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ZaloDeliveryRunner.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private leaseExtendedAt = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly prisma: PrismaService,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release'>,
    private readonly client: Pick<ZaloClient, 'sendTemplate'>,
    private readonly tokens: Pick<ZaloTokenService, 'access'>,
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
        .catch((error: unknown) => this.logger.warn(`Zalo 발송 회차 실패 — ${messageOf(error)}`))
        .finally(() => {
          this.running = undefined;
          this.schedule(TICK_MS);
        });
    }, delayMs);
  }

  /** 한 회차. 검사는 이것을 직접 부른다. */
  async tick(now: Date = new Date()): Promise<void> {
    if (!(await this.lease.acquire().catch(() => false))) return;
    this.leaseExtendedAt = Date.now();
    await this.settleOrphans(now);
    await this.expire(now);

    const connection = await this.prisma.zalo_connection.findUnique({
      where: { zalo_connection_id: ZALO_CONNECTION_ID },
      select: { status_code: true },
    });
    // 연결이 준비되지 않았으면 보내지 않는다 — 만료는 위에서 흘렀고, 남은 대기 건에 이유를 남긴다(data-model §3 · FR-032).
    if (connection?.status_code !== 'ACTIVE') {
      await this.holdForConnection(now);
      return;
    }
    let access = await this.tokens.access(now);
    if (access === null) return;

    try {
      for (let claimed = await this.claim(now); claimed.length > 0; claimed = await this.claim(now)) {
        const templates = await this.templates();
        for (const [index, delivery] of claimed.entries()) {
          await this.keepGoing(claimed.slice(index));
          const next = await this.deliver(delivery, templates, access, now);
          if (next === null) {
            // 토큰을 다시 받지 못했다 — 남은 건을 대기로 돌려놓고 회차를 마친다.
            await this.release(claimed.slice(index + 1), CONNECTION_NOT_READY, '연결 재인증이 필요합니다.');
            return;
          }
          access = next;
        }
        if (claimed.length < BATCH_SIZE) return;
      }
    } catch (error) {
      if (error instanceof Stopping || error instanceof LeaseLost) return;
      throw error;
    }
  }

  /** 한 건 보내고 결과를 적는다. 토큰을 잃었으면 `null`. */
  private async deliver(
    delivery: Delivery,
    templates: Map<string, string>,
    access: ZaloAccess,
    now: Date,
  ): Promise<ZaloAccess | null> {
    const templateId = templates.get(delivery.event_type_code);
    if (templateId === undefined) {
      await this.finish(delivery, { status_code: 'FAILED', last_error_code: 'TEMPLATE_NOT_SET', last_error_message: '이 이벤트의 Zalo 템플릿 ID 가 없습니다.' });
      return access;
    }
    const message = {
      phone: delivery.phone_number,
      templateId,
      templateData: delivery.template_data as Record<string, string>,
      trackingId: delivery.tracking_id,
    };
    let result = await this.client.sendTemplate(access.accessToken, message);
    if (!result.ok && classifyZaloError(result.code) === 'TOKEN') {
      // -124 — 갱신하고 같은 tick 에서 한 번 더 보낸다. 토큰 문제는 시도로 세지 않는다.
      const renewed = await this.tokens.access(new Date(), true);
      if (renewed === null) {
        await this.finish(delivery, { status_code: 'PENDING', last_error_code: CONNECTION_NOT_READY, last_error_message: '연결 재인증이 필요합니다.' });
        return null;
      }
      access = renewed;
      result = await this.client.sendTemplate(access.accessToken, message);
    }

    if (result.ok) {
      await this.finish(delivery, {
        status_code: 'SENT', attempt_count: delivery.attempt_count + 1, zalo_msg_id: result.msgId, sent_at: new Date(),
        last_error_code: null, last_error_message: null,
      });
      return access;
    }
    const error = { last_error_code: result.code.slice(0, 20), last_error_message: result.message || null };
    const kind = classifyZaloError(result.code);
    if (kind === 'DEFER_0700') {
      // 시간·한도 유예 — 실패로 세지 않고 다음 07:00 로 미룬다. 만료(24h)는 그대로 흐른다.
      await this.finish(delivery, { status_code: 'PENDING', next_attempt_at: nextSiteMorning(now), ...error });
      return access;
    }
    const attempts = delivery.attempt_count + 1;
    if (kind === 'FAIL_RECIPIENT' || kind === 'FAIL_CONFIG' || kind === 'TOKEN' || attempts >= MAX_ATTEMPTS) {
      await this.finish(delivery, { status_code: 'FAILED', attempt_count: attempts, ...error });
      if (kind === 'FAIL_CONFIG') await this.recordConfigError(error.last_error_code, error.last_error_message);
      return access;
    }
    await this.finish(delivery, {
      status_code: 'PENDING', attempt_count: attempts, next_attempt_at: new Date(now.getTime() + BACKOFF_MS[attempts - 1]), ...error,
    });
    return access;
  }

  /**
   * 대기 건을 묶음으로 잡는다 — `SENDING` 으로 바꾸고 `updated_at` 에 잡은 시각을 남긴다.
   * `SKIP LOCKED` 로 다른 회차·인스턴스와 겹치지 않는다(리스가 한 겹 더 막는다).
   */
  private claim(now: Date): Promise<Delivery[]> {
    return this.prisma.$queryRaw<Delivery[]>`
      UPDATE app.zalo_delivery d
         SET status_code = 'SENDING', updated_at = clock_timestamp()
       WHERE d.zalo_delivery_id IN (
         SELECT zalo_delivery_id FROM app.zalo_delivery
          WHERE status_code = 'PENDING' AND next_attempt_at <= ${now} AND expires_at > ${now}
          ORDER BY next_attempt_at, zalo_delivery_id
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED)
      RETURNING d.zalo_delivery_id, d.phone_number, d.event_type_code, d.template_data, d.tracking_id, d.attempt_count`;
  }

  /** 러너가 죽어 `SENDING` 으로 남은 건 — 다시 보내지 않는다(FR-026). */
  private async settleOrphans(now: Date): Promise<void> {
    const settled = await this.prisma.zalo_delivery.updateMany({
      where: { status_code: 'SENDING', updated_at: { lt: new Date(now.getTime() - LEASE_TTL_MS) } },
      data: {
        status_code: 'FAILED',
        last_error_code: 'UNKNOWN_OUTCOME',
        last_error_message: '발송 결과를 알 수 없어 다시 보내지 않았습니다. tracking_id 로 Zalo 기록과 대조하세요.',
        updated_at: new Date(),
      },
    });
    if (settled.count > 0) this.logger.warn(`결과를 모르는 Zalo 발송 ${settled.count}건을 FAILED(UNKNOWN_OUTCOME)로 끝냈다`);
  }

  /**
   * 연결 미설정·재인증 필요 동안의 대기 건 — `PENDING`(`CONNECTION_NOT_READY`)으로 보류한다. 시도 수는 그대로이고
   * 만료(24h)는 흐른다. 이유가 없으면 발송 이력(W-CO-13)에서 왜 안 나갔는지 보이지 않는다.
   * 이미 그 이유인 건은 건드리지 않는다 — 회차마다 같은 행을 다시 쓰지 않게.
   */
  private async holdForConnection(now: Date): Promise<void> {
    await this.prisma.zalo_delivery.updateMany({
      where: {
        status_code: 'PENDING',
        expires_at: { gt: now },
        OR: [{ last_error_code: null }, { last_error_code: { not: CONNECTION_NOT_READY } }],
      },
      data: { last_error_code: CONNECTION_NOT_READY, last_error_message: CONNECTION_NOT_READY_MESSAGE, updated_at: new Date() },
    });
  }

  private async expire(now: Date): Promise<void> {
    await this.prisma.zalo_delivery.updateMany({
      where: { status_code: 'PENDING', expires_at: { lte: now } },
      data: { status_code: 'EXPIRED', updated_at: new Date() },
    });
  }

  private async templates(): Promise<Map<string, string>> {
    const rows = await this.prisma.zalo_template.findMany();
    return new Map(rows.map((row) => [row.event_type_code, row.template_id]));
  }

  private async finish(delivery: Delivery, data: Prisma.zalo_deliveryUpdateInput): Promise<void> {
    await this.prisma.zalo_delivery.update({
      where: { zalo_delivery_id: delivery.zalo_delivery_id },
      data: { ...data, updated_at: new Date() },
    });
  }

  /** 잡았지만 보내지 못한 건을 대기로 돌린다 — 시도 횟수는 그대로다. */
  private async release(deliveries: Delivery[], code: string, message: string): Promise<void> {
    if (deliveries.length === 0) return;
    await this.prisma.zalo_delivery.updateMany({
      where: { zalo_delivery_id: { in: deliveries.map((d) => d.zalo_delivery_id) }, status_code: 'SENDING' },
      data: { status_code: 'PENDING', last_error_code: code, last_error_message: message, updated_at: new Date() },
    });
  }

  /** 설정 오류는 연결 화면에 마지막 오류로 보인다(research R-3). 상태는 바꾸지 않는다. */
  private async recordConfigError(code: string, message: string | null): Promise<void> {
    await this.prisma.zalo_connection.updateMany({
      where: { zalo_connection_id: ZALO_CONNECTION_ID },
      data: { last_error_code: code, last_error_message: message, updated_at: new Date() },
    });
  }

  /** 건마다 멈출 때인지 보고, 30초가 지났으면 리스를 늘린다. 멈추면 잡아 둔 건을 대기로 돌린다. */
  private async keepGoing(remaining: Delivery[]): Promise<void> {
    let reason: Error | null = this.stopping ? new Stopping() : null;
    if (reason === null && Date.now() - this.leaseExtendedAt >= LEASE_EXTEND_MS) {
      if (await this.lease.acquire().catch(() => false)) this.leaseExtendedAt = Date.now();
      else reason = new LeaseLost();
    }
    if (reason === null) return;
    await this.release(remaining, 'INTERRUPTED', '러너가 멈춰 다음 회차로 넘겼습니다.');
    throw reason;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
