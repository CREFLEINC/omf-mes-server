import { PrismaService } from '../../prisma/prisma.service';
import type { InboundResult } from './inbound-cycle';

export const SYNC_STATUS = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED' } as const;

/**
 * 받는 표마다 한 줄(`integration.erp_sync_state` · 장부 P-81) — 「지금 읽기」 요청과 마지막 회차.
 * 실행기가 쓰고 화면(연동 현황 탭)이 읽는다. 요청은 화면이 적고 실행기가 지운다.
 *
 * ⭐ 상태는 곁가지다 — 실행기는 여기 쓰다 실패해도 받기를 멈추지 않는다(`ErpSyncRunner` 가 잡아 로그만 남긴다).
 */
export class SyncState {
  constructor(private readonly prisma: PrismaService) {}

  /** 요청이 걸린 표 → 요청 시각. 실행기가 쉬는 동안 몇 초마다 본다. */
  async requested(): Promise<Map<string, Date>> {
    const rows = await this.prisma.erp_sync_state.findMany({
      where: { requested_at: { not: null } },
      select: { interface_code: true, requested_at: true },
    });
    return new Map(rows.map((row) => [row.interface_code, row.requested_at as Date]));
  }

  async started(interfaceCode: string, at: Date): Promise<void> {
    await this.prisma.erp_sync_state.upsert({
      where: { interface_code: interfaceCode },
      create: { interface_code: interfaceCode, last_started_at: at },
      update: { last_started_at: at, updated_at: new Date() },
    });
  }

  /** 행 실패가 있어도 회차는 «성공»이다 — 회차가 끝까지 돌았다는 뜻이고, 실패 행 수는 따로 싣는다. */
  async succeeded(interfaceCode: string, result: InboundResult): Promise<void> {
    await this.finished(interfaceCode, {
      last_status_code: SYNC_STATUS.SUCCEEDED,
      last_read_count: result.read,
      last_applied_count: result.applied,
      last_failed_count: result.failed,
      last_held_count: result.held,
      last_error_message: null,
    });
  }

  /** 회차 자체가 멈췄다 — 중계 DB 에 못 닿았거나 읽다 끊겼다. */
  async failed(interfaceCode: string, message: string): Promise<void> {
    await this.finished(interfaceCode, {
      last_status_code: SYNC_STATUS.FAILED,
      last_read_count: null,
      last_applied_count: null,
      last_failed_count: null,
      last_held_count: null,
      last_error_message: message.slice(0, 2000),
    });
  }

  /**
   * 그 표를 돌기 시작한 시각까지의 요청만 지운다 — 도는 사이에 또 누른 요청은 남아 한 번 더 돈다.
   */
  async clearRequest(interfaceCode: string, startedAt: Date): Promise<void> {
    await this.prisma.erp_sync_state.updateMany({
      where: { interface_code: interfaceCode, requested_at: { lte: startedAt } },
      data: { requested_at: null, requested_by: null, updated_at: new Date() },
    });
  }

  /** 묶음의 다음 주기 회차 시각. 리스를 쥔 쪽만 쓴다 — 실행기의 «다음 예정»은 그쪽 메모리에만 있다. */
  async scheduled(interfaceCodes: readonly string[], at: Date): Promise<void> {
    for (const interfaceCode of interfaceCodes) {
      await this.prisma.erp_sync_state.upsert({
        where: { interface_code: interfaceCode },
        create: { interface_code: interfaceCode, next_run_at: at },
        update: { next_run_at: at, updated_at: new Date() },
      });
    }
  }

  private async finished(
    interfaceCode: string,
    values: {
      last_status_code: string;
      last_read_count: number | null;
      last_applied_count: number | null;
      last_failed_count: number | null;
      last_held_count: number | null;
      last_error_message: string | null;
    },
  ): Promise<void> {
    const at = new Date();
    await this.prisma.erp_sync_state.upsert({
      where: { interface_code: interfaceCode },
      create: { interface_code: interfaceCode, last_finished_at: at, ...values },
      update: { last_finished_at: at, updated_at: at, ...values },
    });
  }
}
