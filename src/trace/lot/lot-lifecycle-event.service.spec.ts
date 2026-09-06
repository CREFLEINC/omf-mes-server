import { LotLifecycleEventRow, lotLifecycleEventView } from './lot-lifecycle-event-view';
import {
  LOT_LIFECYCLE_EVENT_ORDER_BY,
  LotLifecycleTransitionCode,
  buildLotLifecycleEventWhere,
} from './lot-lifecycle-event.service';

const FROM = '2026-09-06T00:00:00.000Z';
const TO = '2026-09-06T23:59:59.000Z';
const CHANGED_AT = new Date('2026-09-06T02:00:00.000Z');

function row(overrides: Partial<LotLifecycleEventRow> = {}): LotLifecycleEventRow {
  return {
    lot_lifecycle_history_id: 77n,
    lot_id: 12n,
    from_lifecycle_status_code: null,
    to_lifecycle_status_code: 'ACTIVE',
    transition_code: 'L1',
    source_document_type_code: null,
    source_document_id: null,
    changed_at: CHANGED_AT,
    created_at: CHANGED_AT,
    lot: { lot_no: 'LOT-0001' },
    ...overrides,
  };
}

describe('LOT 생명주기 변경이력 조회 (I-7 PR ①)', () => {
  it('이벤트 — `transitionCode` 는 L1·L2·L3 만 받는다', () => {
    const codes: LotLifecycleTransitionCode[] = ['L1', 'L2', 'L3'];

    for (const transitionCode of codes) {
      expect(buildLotLifecycleEventWhere({ occurredFrom: FROM, occurredTo: TO, transitionCode })).toEqual({
        changed_at: { gte: new Date(FROM), lt: new Date(TO) },
        transition_code: transitionCode,
      });
    }
    // 계약 enum 밖은 가드가 400 을 내고 타입이 닫는다 — 빌더는 「안 주면 조건도 없다」뿐이다.
    expect(buildLotLifecycleEventWhere({ occurredFrom: FROM, occurredTo: TO, lotId: 12 })).toEqual({
      changed_at: { gte: new Date(FROM), lt: new Date(TO) },
      lot_id: 12,
    });
    expect(LOT_LIFECYCLE_EVENT_ORDER_BY).toEqual([{ changed_at: 'desc' }, { lot_lifecycle_history_id: 'desc' }]);
  });

  it('이벤트 — `fromLifecycleStatusCode` 가 NULL 이면 키를 생략한다(L1)', () => {
    const view = lotLifecycleEventView(row());

    // 계약 ⌜최초 전이(L1)는 null 이다⌝ — 우리는 널 대신 키를 없앤다(형제 뷰 관행).
    expect(Object.keys(view)).not.toContain('fromLifecycleStatusCode');
    expect(Object.keys(view)).not.toContain('sourceDocumentTypeCode');
    expect(Object.keys(view)).not.toContain('sourceDocumentId');
    expect(view).toEqual({
      lotLifecycleHistoryId: 77,
      lotId: 12,
      lotNo: 'LOT-0001',
      toLifecycleStatusCode: 'ACTIVE',
      transitionCode: 'L1',
      changedAt: CHANGED_AT.toISOString(),
    });

    // L2 는 셋이 다 찬다 — 마감이 찍는 값이 계약 enum 의 `WORK_ORDER_CLOSING` 이다(R-2).
    expect(
      lotLifecycleEventView(
        row({
          from_lifecycle_status_code: 'WAITING',
          to_lifecycle_status_code: 'VOIDED',
          transition_code: 'L2',
          source_document_type_code: 'WORK_ORDER_CLOSING',
          source_document_id: 900n,
        }),
      ),
    ).toMatchObject({
      fromLifecycleStatusCode: 'WAITING',
      sourceDocumentTypeCode: 'WORK_ORDER_CLOSING',
      sourceDocumentId: 900,
    });
  });
});
