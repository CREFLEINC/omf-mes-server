/**
 * ERP 「지금 읽기」(장부 P-81) — 실제 MSSQL 에 붙어 실행기를 진짜로 돌린다(`erp-relay.fixture.ts`).
 * 주기를 12시간으로 두고, 첫 회차가 끝난 뒤 중계 표에 행을 넣고 요청하면 그 주기를 기다리지 않고 몇 초 안에 들어오는지 본다.
 * 원본 표 대신 사본(`E2E_*`)·다른 리스 이름을 써서 공유 중계 DB 와 돌고 있는 서버를 건드리지 않는다.
 */
import { ConfigService } from '@nestjs/config';
import * as mssql from 'mssql';

import { commonCodeTable } from '../src/integration/erp/apply/common-code.apply';
import { ErpSyncStatusService } from '../src/integration/erp/erp-sync-status.service';
import { ErpSyncRunner, Lane, REQUEST_POLL_MS, STARTUP_DELAY_MS } from '../src/integration/erp/erp-sync.runner';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { COMMON_CODE } from '../src/integration/erp/relay-tables';
import { SyncLease } from '../src/integration/erp/sync-lease';
import { SyncState } from '../src/integration/erp/sync-state';
import { PrismaService } from '../src/prisma/prisma.service';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy, flagsOf, insertRow } from './erp-relay.fixture';

const COPY = 'E2E_MANUAL_TYPE_TIG_DOWN';
const PREFIX = 'E2EM_';
const CODE = 'E2E-IF-ERP-MANUAL-RECV';
const LEASE = 'e2e-erp-sync-manual';
const TABLE = { ...commonCodeTable, source: { ...COMMON_CODE, interfaceCode: CODE, name: COPY } };
const LANE: Lane = { code: 'MASTER', name: '기준정보', tables: [TABLE], intervalMs: 12 * 3_600_000 };

describeRelay('ERP 지금 읽기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let runner: ErpSyncRunner;
  let status: ErpSyncStatusService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, COMMON_CODE.name);
    await cleanup();
    const relay = new RelayClient(RELAY);
    runner = new ErpSyncRunner(
      true,
      [LANE],
      new InboundCycle(prisma, relay),
      new SyncLease(prisma, LEASE),
      relay,
      new SyncState(prisma),
    );
    const config = { get: (name: string) => (name === 'ERP_SYNC_ENABLED' ? 'true' : undefined) } as ConfigService;
    status = new ErpSyncStatusService(prisma, config, [LANE]);
  });

  afterAll(async () => {
    await runner?.onApplicationShutdown();
    await cleanup();
    await dropCopy(sa, COPY);
    await sa?.close();
    await prisma?.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.integration_message.deleteMany({ where: { interface_code: CODE } });
    await prisma.erp_sync_state.deleteMany({ where: { interface_code: CODE } });
    await prisma.sync_lease.deleteMany({ where: { lease_name: LEASE } });
    await prisma.code_value.deleteMany({ where: { code_group: { group_code: { startsWith: PREFIX } } } });
    await prisma.code_group.deleteMany({ where: { group_code: { startsWith: PREFIX } } });
  }

  const state = () => prisma.erp_sync_state.findUnique({ where: { interface_code: CODE } });

  async function until(check: () => Promise<boolean>, limitMs: number): Promise<number> {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > limitMs) throw new Error(`${limitMs}ms 안에 끝나지 않았다`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return Date.now() - start;
  }

  it('⭐ 첫 회차 뒤 넣은 행이 12시간을 기다리지 않고 요청 몇 초 안에 들어오고, 결과가 남는다', async () => {
    runner.onApplicationBootstrap();
    await until(async () => (await state())?.last_finished_at != null, STARTUP_DELAY_MS + 10_000);
    const first = await state();
    expect(first).toMatchObject({ last_status_code: 'SUCCEEDED', last_read_count: 0 });
    // 다음 주기 회차는 12시간 뒤다.
    expect(first?.next_run_at?.getTime()).toBeGreaterThan(Date.now() + 11 * 3_600_000);

    await insertRow(sa, COPY, {
      T_SEQ: 1,
      T_FLAG: 'I',
      TYPE_CODE: `${PREFIX}UNIT`,
      TYPE_NAME: '단위코드',
      CODE: 'GR',
      CODE_NAME: 'Gram',
      IF_YN: 'N',
    });
    const { requestedAt } = await status.request(CODE, 1);
    const elapsed = await until(async () => {
      const row = await state();
      return row?.requested_at === null && (row.last_finished_at?.getTime() ?? 0) >= new Date(requestedAt).getTime();
    }, REQUEST_POLL_MS + 10_000);

    expect(elapsed).toBeLessThan(REQUEST_POLL_MS + 5_000);
    expect(await state()).toMatchObject({
      last_status_code: 'SUCCEEDED',
      last_read_count: 1,
      last_applied_count: 1,
      last_failed_count: 0,
    });
    expect(
      await prisma.code_value.findFirst({ where: { code: 'GR', code_group: { group_code: `${PREFIX}UNIT` } } }),
    ).toMatchObject({ code_name: 'Gram' });
    expect(await flagsOf(sa, COPY, 'CODE', 'IF_YN')).toEqual({ GR: 'Y' });
  }, 60_000);
});
