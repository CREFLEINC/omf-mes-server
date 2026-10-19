import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { InboundCycle, InboundTable } from './inbound-cycle';
import { RelayClient } from './relay-client';
import { SyncLease } from './sync-lease';

/** 같은 주기로 도는 표 묶음. 표는 적힌 순서대로 돈다 — 참조되는 쪽이 앞이다. */
export interface Lane {
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
    if (!(await this.lease.acquire().catch(() => false))) {
      this.schedule(LEASE_RETRY_MS);
      return;
    }
    for (const lane of this.lanes) {
      if (this.stopping) return;
      if ((this.due.get(lane) ?? 0) > Date.now()) continue;
      try {
        for (const table of lane.tables) await this.cycle.run(table, () => this.keepGoing());
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
    }
    this.schedule(Math.max(0, Math.min(...this.due.values()) - Date.now()));
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
