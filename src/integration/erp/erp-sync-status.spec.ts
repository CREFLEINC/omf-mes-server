import { erp_sync_state } from '@prisma/client';

import { statusView } from './erp-sync-status.service';

const LANE = { code: 'ORDER' as const, name: '전표' };
const at = (time: string): Date => new Date(`2026-10-21T${time}:00.000Z`);
const row = (values: Partial<erp_sync_state>): erp_sync_state => ({
  interface_code: 'IF-ERP-PO-RECV',
  requested_at: null,
  requested_by: null,
  last_started_at: null,
  last_finished_at: null,
  last_status_code: null,
  last_read_count: null,
  last_applied_count: null,
  last_failed_count: null,
  last_held_count: null,
  last_error_message: null,
  next_run_at: null,
  updated_at: at('00:00'),
  ...values,
});

describe('ERP 받기 표별 상태 (P-81)', () => {
  it('한 번도 돌지 않은 표는 칸이 모두 null 이고 도는 중이 아니다', () => {
    expect(statusView('IF-ERP-PO-RECV', '구매발주', LANE, undefined, true)).toEqual({
      interfaceCode: 'IF-ERP-PO-RECV',
      name: '구매발주',
      laneCode: 'ORDER',
      laneName: '전표',
      running: false,
      requestedAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastStatusCode: null,
      lastReadCount: null,
      lastAppliedCount: null,
      lastFailedCount: null,
      lastHeldCount: null,
      lastErrorMessage: null,
      nextRunAt: null,
    });
  });

  it('시작이 마지막 끝보다 늦고 리스가 살아 있으면 도는 중이다', () => {
    const view = statusView('IF-ERP-PO-RECV', '구매발주', LANE, row({ last_started_at: at('01:10'), last_finished_at: at('01:00') }), true);
    expect(view.running).toBe(true);
    expect(statusView('IF-ERP-PO-RECV', '구매발주', LANE, row({ last_started_at: at('01:10') }), true).running).toBe(true);
  });

  it('⛔ 리스가 끝났으면 도는 중이 아니다 — 회차 중에 서버가 죽으면 끝 시각이 남지 않는다', () => {
    const view = statusView('IF-ERP-PO-RECV', '구매발주', LANE, row({ last_started_at: at('01:10'), last_finished_at: at('01:00') }), false);
    expect(view.running).toBe(false);
  });

  it('끝이 시작보다 늦으면 도는 중이 아니고 결과를 싣는다', () => {
    const view = statusView(
      'IF-ERP-PO-RECV',
      '구매발주',
      LANE,
      row({
        requested_at: at('02:00'),
        last_started_at: at('01:00'),
        last_finished_at: at('01:05'),
        last_status_code: 'SUCCEEDED',
        last_read_count: 12,
        last_applied_count: 10,
        last_failed_count: 2,
        last_held_count: 0,
        next_run_at: at('01:20'),
      }),
      true,
    );
    expect(view).toMatchObject({
      running: false,
      requestedAt: '2026-10-21T02:00:00.000Z',
      lastFinishedAt: '2026-10-21T01:05:00.000Z',
      lastStatusCode: 'SUCCEEDED',
      lastReadCount: 12,
      lastAppliedCount: 10,
      lastFailedCount: 2,
      lastHeldCount: 0,
      nextRunAt: '2026-10-21T01:20:00.000Z',
    });
  });
});
