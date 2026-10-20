import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { InboundCycle, InboundTable } from './inbound-cycle';
import { RelayClient } from './relay-client';
import { SyncLease } from './sync-lease';
import { SyncState } from './sync-state';

/** 같은 주기로 도는 표 묶음. 표는 적힌 순서대로 돈다 — 참조되는 쪽이 앞이다. */
export interface Lane {
  code: 'MASTER' | 'ORDER';
  name: string;
  tables: InboundTable[];
  intervalMs: number;
}

/** 부팅 직후 바로 돌지 않는다 — 헬스체크가 먼저 통과해야 블루-그린 전환이 된다. */
export const STARTUP_DELAY_MS = 10_000;
/** 리스를 남이 쥐고 있을 때 다시 보는 간격. 그쪽이 멈추면 늦어도 이만큼 뒤에 넘겨받는다. */
export const LEASE_RETRY_MS = 60_000;
/** 중계 DB 에 못 닿으면 1분부터 배로 늘려 다시 시도한다. 1시간과 그 표의 주기 중 짧은 쪽이 상한이다. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;
/** 쉬는 동안 「지금 읽기」 요청을 보는 간격(장부 P-81). 리스 없이 요청 표만 읽는다. */
export const REQUEST_POLL_MS = 10_000;

class Stopping extends Error {}
class LeaseLost extends Error {}

/**
 * ERP 연동 실행기 — 회차를 «끝나면 N초 뒤» 로 잡는다. 시계에 맞춰 무조건 돌리면 긴 회차와
 * 다음 회차가 겹친다.
 *
 * ⭐ 종료 신호를 받으면 «다음 묶음 경계»에서 멈춘다. `docker stop` 유예는 10초라 회차가 끝나길
 * 기다리면 강제로 죽는다. 중간에 멈춰도 같은 행이 다음 회차에 다시 와서 같은 결과를 낸다.
 */
export class ErpSyncRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ErpSyncRunner.name);
  private readonly due = new Map<Lane, number>();
  private readonly failures = new Map<Lane, number>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly enabled: boolean,
    private readonly lanes: Lane[],
    private readonly cycle: Pick<InboundCycle, 'run'>,
    private readonly lease: Pick<SyncLease, 'acquire' | 'release'>,
    private readonly relay: Pick<RelayClient, 'close'>,
    private readonly state: Pick<
      SyncState,
      'requested' | 'started' | 'succeeded' | 'failed' | 'clearRequest' | 'scheduled'
    >,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.lanes.forEach((lane) => this.due.set(lane, 0));
    this.schedule(STARTUP_DELAY_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
    if (!this.enabled) return;
    await this.lease
      .release()
      .catch((error: unknown) => this.logger.warn(`리스 반납 실패 — ${messageOf(error)}`));
    await this.relay
      .close()
      .catch((error: unknown) => this.logger.warn(`중계 DB 닫기 실패 — ${messageOf(error)}`));
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => (this.running = undefined));
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const requests = await this.state.requested().catch((error: unknown) => {
      this.logger.warn(`「지금 읽기」 요청을 못 읽었다 — ${messageOf(error)}`);
      return new Map<string, Date>();
    });
    const now = Date.now();
    if (requests.size === 0 && this.lanes.every((lane) => (this.due.get(lane) ?? 0) > now)) {
      this.schedule(this.nextDelay());
      return;
    }
    if (!(await this.lease.acquire().catch(() => false))) {
      this.schedule(LEASE_RETRY_MS);
      return;
    }
    // 사람이 누른 표가 먼저다 — 주기 회차를 기다리지 않는다. 여럿이면 묶음에 적힌 순서(참조되는 쪽이 앞)로 돈다.
    for (const table of this.lanes.flatMap((lane) => lane.tables)) {
      const code = table.source.interfaceCode;
      if (!requests.has(code)) continue;
      if (this.stopping) return;
      const startedAt = new Date();
      try {
        await this.runTable(table, startedAt);
      } catch (error) {
        if (error instanceof Stopping) return;
        if (error instanceof LeaseLost) {
          this.logger.warn(`${table.source.label} 「지금 읽기」 — 리스를 잃어 멈춘다`);
          this.schedule(LEASE_RETRY_MS);
          return;
        }
        this.logger.warn(`${table.source.label} 「지금 읽기」 실패 — ${messageOf(error)}`);
      }
      // 실패해도 지운다 — 다시 누르면 다시 돈다. 도는 사이에 또 누른 요청은 남는다.
      await this.record(() => this.state.clearRequest(code, startedAt));
    }
    for (const lane of this.lanes) {
      if (this.stopping) return;
      if ((this.due.get(lane) ?? 0) > Date.now()) continue;
      try {
        for (const table of lane.tables) await this.runTable(table, new Date());
        this.failures.set(lane, 0);
        this.due.set(lane, Date.now() + lane.intervalMs);
      } catch (error) {
        if (error instanceof Stopping) return;
        if (error instanceof LeaseLost) {
          this.logger.warn(`${lane.name} — 리스를 잃어 회차를 멈춘다`);
          this.schedule(LEASE_RETRY_MS);
          return;
        }
        const failures = (this.failures.get(lane) ?? 0) + 1;
        this.failures.set(lane, failures);
        const retryMs = Math.min(
          RETRY_BASE_MS * 2 ** (failures - 1),
          RETRY_MAX_MS,
          lane.intervalMs,
        );
        this.due.set(lane, Date.now() + retryMs);
        this.logger.warn(
          `${lane.name} 회차 실패(${failures}번째, ${retryMs / 1000}초 뒤 다시) — ${messageOf(error)}`,
        );
      }
      const next = new Date(this.due.get(lane) ?? Date.now());
      await this.record(() => this.state.scheduled(lane.tables.map((table) => table.source.interfaceCode), next));
    }
    this.schedule(this.nextDelay());
  }

  /** 표 하나를 돌고 결과를 남긴다. 멈춤·리스 상실은 «결과»가 아니라 남기지 않는다 — 다음 회차가 덮는다. */
  private async runTable(table: InboundTable, startedAt: Date): Promise<void> {
    const code = table.source.interfaceCode;
    await this.record(() => this.state.started(code, startedAt));
    try {
      const result = await this.cycle.run(table, () => this.keepGoing());
      await this.record(() => this.state.succeeded(code, result));
    } catch (error) {
      if (!(error instanceof Stopping) && !(error instanceof LeaseLost)) {
        await this.record(() => this.state.failed(code, messageOf(error)));
      }
      throw error;
    }
  }

  /** 상태는 곁가지다 — 못 써도 받기는 이어 간다. */
  private async record(write: () => Promise<void>): Promise<void> {
    await write().catch((error: unknown) => this.logger.warn(`연동 상태를 못 남겼다 — ${messageOf(error)}`));
  }

  /** 가장 이른 묶음 예정 시각까지 — 단, 요청을 보러 몇 초마다는 깬다. */
  private nextDelay(): number {
    return Math.max(0, Math.min(REQUEST_POLL_MS, Math.min(...this.due.values()) - Date.now()));
  }

  /** 묶음마다 — 멈출 때인지 보고 리스를 늘린다. */
  private async keepGoing(): Promise<void> {
    if (this.stopping) throw new Stopping();
    if (!(await this.lease.acquire())) throw new LeaseLost();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
