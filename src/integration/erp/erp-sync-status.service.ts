import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { erp_sync_state } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { Lane } from './erp-sync.runner';
import { ERP_SYNC_LEASE } from './sync-lease';

/** 실행기와 연동 현황이 함께 보는 묶음 목록(`erp-sync.module.ts` 가 만든다). */
export const ERP_SYNC_LANES = Symbol('ERP_SYNC_LANES');

export interface ErpSyncTableStatus {
  interfaceCode: string;
  name: string;
  laneCode: Lane['code'];
  laneName: string;
  /** 지금 이 표를 도는 중 — 시작이 마지막 끝보다 늦고, 실행기가 리스를 쥐고 있다. */
  running: boolean;
  /** 「지금 읽기」가 걸려 있으면 그 시각. 실행기가 돌기 시작하면 지운다. */
  requestedAt: string | null;
  lastStartedAt: string | null;
  /** 아래 결과 칸은 «마지막으로 끝난» 회차의 것이다 — 도는 중이면 그 앞 회차다. */
  lastFinishedAt: string | null;
  lastStatusCode: string | null;
  lastReadCount: number | null;
  lastAppliedCount: number | null;
  lastFailedCount: number | null;
  lastHeldCount: number | null;
  lastErrorMessage: string | null;
  /** 다음 주기 회차 예정. 실행기가 아직 한 번도 돌지 않았으면 null. */
  nextRunAt: string | null;
}

export interface ErpSyncStatus {
  /** 이 서버에서 ERP 연동이 켜져 있는가(`ERP_SYNC_ENABLED`). 꺼져 있으면 「지금 읽기」가 400 이다. */
  enabled: boolean;
  items: ErpSyncTableStatus[];
}

/**
 * 연동 현황 탭의 「지금 읽기」와 표별 상태(장부 P-81). 요청은 적어 두기만 한다 — 실제 회차는 리스를 쥔
 * 실행기가 몇 초 안에 돈다(블루-그린 두 쪽 중 어느 api 가 요청을 받아도 같다).
 */
@Injectable()
export class ErpSyncStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(ERP_SYNC_LANES) private readonly lanes: Lane[],
  ) {}

  async list(now = new Date()): Promise<ErpSyncStatus> {
    const [rows, lease] = await Promise.all([
      this.prisma.erp_sync_state.findMany(),
      this.prisma.sync_lease.findUnique({ where: { lease_name: ERP_SYNC_LEASE } }),
    ]);
    const byCode = new Map(rows.map((row) => [row.interface_code, row]));
    const leaseAlive = lease !== null && lease.expires_at > now;
    return {
      enabled: this.enabled(),
      items: this.lanes.flatMap((lane) =>
        lane.tables.map(({ source }) => statusView(source.interfaceCode, source.label, lane, byCode.get(source.interfaceCode), leaseAlive)),
      ),
    };
  }

  /** 이미 걸린 요청은 시각을 바꾸지 않는다 — 여러 번 눌러도 한 번 돈다. */
  async request(interfaceCode: string, appUserId: number): Promise<{ interfaceCode: string; requestedAt: string }> {
    if (!this.lanes.some((lane) => lane.tables.some((table) => table.source.interfaceCode === interfaceCode))) {
      throw new NotFoundException('없는 ERP 받기 표입니다.');
    }
    if (!this.enabled()) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '이 서버는 ERP 연동이 꺼져 있어 읽어 올 수 없습니다.' },
      ]);
    }
    const [row] = await this.prisma.$queryRaw<{ requested_at: Date }[]>`
      INSERT INTO integration.erp_sync_state (interface_code, requested_at, requested_by)
      VALUES (${interfaceCode}, clock_timestamp(), ${BigInt(appUserId)})
      ON CONFLICT (interface_code) DO UPDATE
         SET requested_at = COALESCE(integration.erp_sync_state.requested_at, EXCLUDED.requested_at),
             requested_by = COALESCE(integration.erp_sync_state.requested_by, EXCLUDED.requested_by),
             updated_at   = clock_timestamp()
      RETURNING requested_at`;
    return { interfaceCode, requestedAt: row.requested_at.toISOString() };
  }

  private enabled(): boolean {
    return this.config.get<string>('ERP_SYNC_ENABLED') === 'true';
  }
}

export function statusView(
  interfaceCode: string,
  name: string,
  lane: Pick<Lane, 'code' | 'name'>,
  row: erp_sync_state | undefined,
  leaseAlive: boolean,
): ErpSyncTableStatus {
  const started = row?.last_started_at ?? null;
  const finished = row?.last_finished_at ?? null;
  return {
    interfaceCode,
    name,
    laneCode: lane.code,
    laneName: lane.name,
    running: leaseAlive && started !== null && (finished === null || finished < started),
    requestedAt: iso(row?.requested_at),
    lastStartedAt: iso(started),
    lastFinishedAt: iso(finished),
    lastStatusCode: row?.last_status_code ?? null,
    lastReadCount: row?.last_read_count ?? null,
    lastAppliedCount: row?.last_applied_count ?? null,
    lastFailedCount: row?.last_failed_count ?? null,
    lastHeldCount: row?.last_held_count ?? null,
    lastErrorMessage: row?.last_error_message ?? null,
    nextRunAt: iso(row?.next_run_at),
  };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
