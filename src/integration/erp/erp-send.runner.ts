import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OUTBOX_DIRECTION } from '../../core/outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MESSAGE_STATUS } from '../message/integration-message.service';
import { OutboundBuilder, OutboundMessage } from './outbound-builder';
import { OutboundReplies } from './outbound-replies';
import {
  OUTBOUND_ROW_STATUS,
  OutboundRows,
  RelayLastIfSeq,
  RelayValues,
  ReservedRow,
  RowDraft,
  documentNoOf,
  rewriteRejected,
} from './outbound-rows';
import { RcvTable, tableNamed } from './rcv-tables';
import { RelayClient, relayUnreachable } from './relay-client';
import { SyncLease } from './sync-lease';

export const ERP_SEND_LEASE = 'erp-send';
/** 10초마다 — 마감한 묶음이 몇 초 안에 중계 DB 에 들어간다. */
export const TICK_MS = 10_000;
export const BATCH_SIZE = 10;
/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다(받기 실행기와 같다). */
export const STARTUP_DELAY_MS = 10_000;
/**
 * 이보다 오래 잡혀 있는 메시지는 쥔 실행기가 죽은 것이다(리스 120초). 대기로 돌려 다시 보낸다 — 키를 예약해 두어
 * 이미 들어간 행은 넣기가 건너뛴다. Zalo 러너는 보냈는지 알 수 없어 다시 보내지 않는 것과 다르다.
 */
export const LOCK_TTL_MS = 120_000;
export const LEASE_EXTEND_MS = 30_000;
/** 중계 DB 에 못 닿으면 1·2·4·8분, 그 뒤 15분마다 — 사람이 고칠 일이 아니라 실패로 두지 않는다. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 15 * 60_000;

type Claimed = OutboundMessage & { retryCount: number };

class Stopping extends Error {}
class LeaseLost extends Error {}

/**
 * ERP 보내기 실행기 — 아웃박스의 대기 메시지(W/O 마감 같은 묶음)를 중계 DB 의 받는 표에 넣는다.
 * 받기 실행기와 따로 돈다(2026-10-21 사용자 결정) — 받기가 BOM 2만 행을 읽는 동안 보내기가 기다리지 않는다.
 * 골격은 Zalo 발송 러너와 같다: `setTimeout` 연쇄, 리스로 한 쪽만, `SKIP LOCKED` 로 잡고 건마다 리스 연장.
 *
 * 한 건 = 바꾸기(바꾸개) → 키 적기(예약) → 넣기(한 트랜잭션) → 처리중·`sent_at`. 회차 끝에 ERP 회신을 읽어 완료·실패를 적는다.
 * ⛔ PG 트랜잭션 안에서 중계 DB 를 부르지 않는다 — 중계 표의 마지막 번호는 예약 «전에» 읽는다.
 */
export class ErpSendRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ErpSendRunner.name);
  private readonly builders: Map<string, OutboundBuilder>;
  private readonly rows: OutboundRows;
  private readonly replies: OutboundReplies;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private leaseExtendedAt = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly prisma: PrismaService,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release' | 'owner'>,
    private readonly relay: Pick<RelayClient, 'insertRows' | 'updateRows' | 'lastIfSeq' | 'replies' | 'close'>,
    builders: readonly OutboundBuilder[],
    /** 예약에 적힌 표 이름 → 표. 다시 잡힌 메시지는 바꾸지 않고 적은 행을 넣는다. */
    private readonly tables: readonly RcvTable[],
  ) {
    this.builders = new Map(builders.map((builder) => [builder.interfaceCode, builder]));
    this.rows = new OutboundRows(prisma);
    this.replies = new OutboundReplies(prisma, relay, tables);
  }

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule(STARTUP_DELAY_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
    if (!this.enabled) return;
    await this.lease.release().catch((error: unknown) => this.logger.warn(`리스 반납 실패 — ${messageOf(error)}`));
    await this.relay.close().catch((error: unknown) => this.logger.warn(`중계 DB 닫기 실패 — ${messageOf(error)}`));
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((error: unknown) => this.logger.warn(`ERP 보내기 회차 실패 — ${messageOf(error)}`))
        .finally(() => {
          this.running = undefined;
          this.schedule(TICK_MS);
        });
    }, delayMs);
  }

  /** 한 회차. 검사는 이것을 직접 부른다. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.builders.size === 0) return;
    if (!(await this.lease.acquire().catch(() => false))) return;
    this.leaseExtendedAt = Date.now();
    await this.releaseOrphans(now);
    try {
      // 중계 DB 에 못 닿았으면 회신도 못 읽는다 — 다음 회차에 둘 다 다시 한다.
      if (!(await this.sendPending(now))) return;
      await this.keepGoing([]);
      await this.replies.read().catch((error: unknown) => {
        if (!relayUnreachable(error)) throw error;
        this.logger.warn(`ERP 회신을 못 읽었다 — ${messageOf(error)}`);
      });
    } catch (error) {
      if (error instanceof Stopping || error instanceof LeaseLost) return;
      throw error;
    }
  }

  /** 대기 메시지를 묶음씩 보낸다. 중계 DB 에 못 닿았으면 false. */
  private async sendPending(now: Date): Promise<boolean> {
    for (let claimed = await this.claim(now); claimed.length > 0; claimed = await this.claim(now)) {
      for (const [index, message] of claimed.entries()) {
        await this.keepGoing(claimed.slice(index));
        if (!(await this.send(message, now))) {
          // 남은 건은 시도 없이 돌려놓고 회차를 마친다.
          await this.release(claimed.slice(index + 1));
          return false;
        }
      }
      if (claimed.length < BATCH_SIZE) return true;
    }
    return true;
  }

  /** 한 건. 중계 DB 에 못 닿았으면 false. */
  private async send(message: Claimed, now: Date): Promise<boolean> {
    let reserved: ReservedRow[];
    try {
      reserved = await this.reserved(message);
    } catch (error) {
      if (relayUnreachable(error)) return this.postpone(message, error, now);
      await this.fail(message, error);
      return true;
    }
    if (reserved.length === 0) {
      await this.finish(message, { status_code: MESSAGE_STATUS.DONE, completed_at: new Date() });
      return true;
    }
    if (reserved.some((row) => row.statusCode === OUTBOUND_ROW_STATUS.REJECTED)) {
      return this.rewrite(message, reserved, now);
    }
    const waiting = reserved.filter((row) => row.statusCode === OUTBOUND_ROW_STATUS.RESERVED);
    if (waiting.length > 0) {
      let ids: number[];
      try {
        ids = await this.relay.insertRows(
          waiting.map((row) => ({ table: tableNamed(this.tables, row.tableName), values: row.values })),
        );
      } catch (error) {
        if (relayUnreachable(error)) return this.postpone(message, error, now);
        // 중계 DB 가 거절했다 — 한 트랜잭션이라 하나도 들어가지 않았다.
        await this.rows.discard(message.id);
        await this.fail(message, error);
        return true;
      }
      // ⚠ 넣은 «뒤»의 실패는 잡지 않는다 — 메시지가 잡힌 채 남아 LOCK_TTL 뒤 다시 잡히고, 같은 키라 넣기가 건너뛴다.
      await this.rows.markInserted(
        waiting.map((row, index) => ({ id: row.id, relayInfId: BigInt(ids[index]) })),
        new Date(),
      );
    }
    await this.finish(message, { status_code: MESSAGE_STATUS.PROCESSING, sent_at: new Date() });
    return true;
  }

  /**
   * ERP 가 거절한 행을 다시 바꾼 값으로 그 자리에서 고친다(2026-10-22 사용자 결정 · 고객 답 — ERP 가 아직 처리하지
   * 않은 행은 고쳐도 된다). 오류 칸을 비우면 ERP 가 다음 주기에 다시 처리한다. 거절되지 않은 행은 그대로 둔다.
   * 그 사이 ERP 가 처리 표시를 바꾼 행은 고치지 않는다 — 회신 읽기가 그 상태를 적는다.
   */
  private async rewrite(message: Claimed, reserved: ReservedRow[], now: Date): Promise<boolean> {
    let fixes: { row: ReservedRow; values: RelayValues }[];
    try {
      fixes = rewriteRejected(reserved, await this.builder(message).build(message));
    } catch (error) {
      await this.fail(message, error);
      return true;
    }
    let counts: number[];
    try {
      counts = await this.relay.updateRows(
        fixes.map(({ row, values }) => ({ table: tableNamed(this.tables, row.tableName), values })),
      );
    } catch (error) {
      if (relayUnreachable(error)) return this.postpone(message, error, now);
      await this.fail(message, error);
      return true;
    }
    await this.rows.markRewritten(fixes.filter((_, index) => counts[index] > 0).map(({ row, values }) => ({ id: row.id, values })));
    await this.finish(message, { status_code: MESSAGE_STATUS.PROCESSING, sent_at: new Date() });
    return true;
  }

  /** 적은 행 — 없으면 바꿔서 적는다. 다시 잡힌 메시지는 바꾸지 않는다(키도 값도 처음 그대로). */
  private async reserved(message: Claimed): Promise<ReservedRow[]> {
    const existing = await this.rows.of(message.id);
    if (existing.length > 0) return existing;
    const drafts = await this.builder(message).build(message);
    if (drafts.length === 0) return [];
    return this.rows.reserve(message.id, drafts, await this.relayLast(drafts));
  }

  private builder(message: Claimed): OutboundBuilder {
    const builder = this.builders.get(message.interfaceCode);
    if (builder === undefined) throw new Error(`바꾸개가 없다: ${message.interfaceCode}`);
    return builder;
  }

  /** 건마다 중계 표의 마지막 IF_SEQ — 예약이 MES 기록과 견준다. */
  private async relayLast(drafts: RowDraft[]): Promise<RelayLastIfSeq> {
    const last = new Map<string, number>();
    for (const { table, values } of drafts) {
      const key = `${table.name}|${documentNoOf(table, values)}`;
      if (!last.has(key)) last.set(key, await this.relay.lastIfSeq(table, values));
    }
    return (table, documentNo) => last.get(`${table.name}|${documentNo}`) ?? 0;
  }

  /** 보낼 차례인 대기 메시지를 잡는다 — 바꾸개가 있는 인터페이스만. `SKIP LOCKED` 에 리스가 한 겹 더 막는다. */
  private async claim(now: Date): Promise<Claimed[]> {
    const rows = await this.prisma.$queryRaw<
      {
        integration_message_id: bigint;
        interface_code: string;
        target_type_code: string;
        target_id: bigint;
        payload: Prisma.JsonValue;
        retry_count: number;
      }[]
    >`
      UPDATE integration.integration_message m
         SET status_code = ${MESSAGE_STATUS.PROCESSING}, locked_at = clock_timestamp(), locked_by = ${this.lease.owner}
       WHERE m.integration_message_id IN (
         SELECT integration_message_id FROM integration.integration_message
          WHERE direction_code = ${OUTBOX_DIRECTION} AND status_code = ${MESSAGE_STATUS.PENDING}
            AND available_at <= ${now} AND interface_code = ANY(${[...this.builders.keys()]})
          ORDER BY available_at, integration_message_id
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED)
      RETURNING m.integration_message_id, m.interface_code, m.target_type_code, m.target_id, m.payload, m.retry_count`;
    return rows
      .sort((a, b) => (a.integration_message_id < b.integration_message_id ? -1 : 1))
      .map((row) => ({
        id: row.integration_message_id,
        interfaceCode: row.interface_code,
        targetTypeCode: row.target_type_code,
        targetId: row.target_id,
        payload: row.payload,
        retryCount: row.retry_count,
      }));
  }

  /** 잡힌 채 LOCK_TTL 이 지난 메시지 — 쥔 실행기가 죽었다. 대기로 돌린다. */
  private async releaseOrphans(now: Date): Promise<void> {
    const released = await this.prisma.integration_message.updateMany({
      where: {
        direction_code: OUTBOX_DIRECTION,
        interface_code: { in: [...this.builders.keys()] },
        status_code: MESSAGE_STATUS.PROCESSING,
        locked_by: { not: null },
        locked_at: { lt: new Date(now.getTime() - LOCK_TTL_MS) },
      },
      data: { status_code: MESSAGE_STATUS.PENDING, locked_at: null, locked_by: null },
    });
    if (released.count > 0) this.logger.warn(`잡힌 채 멈춘 ERP 보내기 ${released.count}건을 대기로 돌렸다`);
  }

  private async fail(message: Claimed, error: unknown): Promise<void> {
    this.logger.warn(`ERP 보내기 실패(메시지 ${message.id}) — ${messageOf(error)}`);
    await this.finish(message, {
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: { increment: 1 },
      last_error_message: messageOf(error),
    });
  }

  private async postpone(message: Claimed, error: unknown, now: Date): Promise<false> {
    const delayMs = Math.min(RETRY_BASE_MS * 2 ** message.retryCount, RETRY_MAX_MS);
    this.logger.warn(`중계 DB 에 닿지 않아 ${delayMs / 1000}초 뒤 다시 보낸다 — ${messageOf(error)}`);
    await this.finish(message, {
      status_code: MESSAGE_STATUS.PENDING,
      retry_count: { increment: 1 },
      available_at: new Date(now.getTime() + delayMs),
      last_error_message: `중계 DB 에 닿지 않았다 — ${messageOf(error)}`,
    });
    return false;
  }

  /** 잡은 것을 놓으며 결과를 적는다. 그 사이 남에게 넘어간 메시지는 건드리지 않는다. */
  private async finish(
    message: Claimed,
    data: Prisma.integration_messageUpdateManyMutationInput,
  ): Promise<void> {
    await this.prisma.integration_message.updateMany({
      where: { integration_message_id: message.id, locked_by: this.lease.owner },
      data: { locked_at: null, locked_by: null, last_error_message: null, ...data },
    });
  }

  /** 잡았지만 시도하지 않은 메시지를 대기로 돌린다 — 시도 횟수는 그대로다. */
  private async release(messages: Claimed[]): Promise<void> {
    if (messages.length === 0) return;
    await this.prisma.integration_message.updateMany({
      where: {
        integration_message_id: { in: messages.map((message) => message.id) },
        locked_by: this.lease.owner,
      },
      data: { status_code: MESSAGE_STATUS.PENDING, locked_at: null, locked_by: null },
    });
  }

  /** 건마다 멈출 때인지 보고, 30초가 지났으면 리스를 늘린다. 멈추면 잡아 둔 건을 대기로 돌린다. */
  private async keepGoing(remaining: Claimed[]): Promise<void> {
    let reason: Error | null = this.stopping ? new Stopping() : null;
    if (reason === null && Date.now() - this.leaseExtendedAt >= LEASE_EXTEND_MS) {
      if (await this.lease.acquire().catch(() => false)) this.leaseExtendedAt = Date.now();
      else reason = new LeaseLost();
    }
    if (reason === null) return;
    await this.release(remaining);
    throw reason;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
