import { LotStatusEventRow, lotStatusEventView } from './lot-status-event-view';
import {
  LOT_STATUS_EVENT_ORDER_BY,
  LotStatusTransitionCode,
  buildLotStatusEventWhere,
} from './lot-status-event.service';

const FROM = '2026-09-06T00:00:00.000Z';
const TO = '2026-09-06T23:59:59.000Z';
const CHANGED_AT = new Date('2026-09-06T02:00:00.000Z');

function row(overrides: Partial<LotStatusEventRow> = {}): LotStatusEventRow {
  return {
    lot_status_event_id: 77n,
    lot_id: 12n,
    location_id: null,
    quality_status_code: null,
    inventory_status_code: null,
    previous_status_code: null,
    new_status_code: 'INSPECTION_PENDING',
    reason_code: null,
    reason: null,
    source_document_type_code: null,
    source_document_id: null,
    changed_at: CHANGED_AT,
    changed_by: 5n,
    created_at: CHANGED_AT,
    transition_code: 'C4',
    lot: { lot_no: 'LOT-0001' },
    ...overrides,
  };
}

describe('LOT 상태 변경이력 조회 (I-18 PR ①)', () => {
  it('기간만 · +lotId · +transitionCode — 안 주면 조건도 없다(반열림 경계 포함)', () => {
    // 기간만 — 반열림(occurredFrom 포함 · occurredTo 미만).
    expect(buildLotStatusEventWhere({ occurredFrom: FROM, occurredTo: TO })).toEqual({
      changed_at: { gte: new Date(FROM), lt: new Date(TO) },
    });

    expect(buildLotStatusEventWhere({ occurredFrom: FROM, occurredTo: TO, lotId: 12 })).toEqual({
      changed_at: { gte: new Date(FROM), lt: new Date(TO) },
      lot_id: 12,
    });

    const codes: LotStatusTransitionCode[] = ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C14', 'C15'];
    for (const transitionCode of codes) {
      expect(buildLotStatusEventWhere({ occurredFrom: FROM, occurredTo: TO, transitionCode })).toEqual({
        changed_at: { gte: new Date(FROM), lt: new Date(TO) },
        transition_code: transitionCode,
      });
    }
  });

  // ⛔ R-4 — enum 밖 값을 안 떨어뜨린다. 가드가 이미 400 을 내는 자리라 빌더는 값이 오면
  //    그대로 좁힌다(형제 `lot-lifecycle-event.service.ts:33-36` 과 같은 판정).
  it('enum 밖 `transitionCode` 가 와도 떨어뜨리지 않는다', () => {
    expect(
      buildLotStatusEventWhere({ occurredFrom: FROM, occurredTo: TO, transitionCode: 'C99' as LotStatusTransitionCode }),
    ).toEqual({
      changed_at: { gte: new Date(FROM), lt: new Date(TO) },
      transition_code: 'C99',
    });
  });

  it('정렬은 `changed_at desc` + PK `lot_status_event_id desc` 2키다', () => {
    expect(LOT_STATUS_EVENT_ORDER_BY).toEqual([{ changed_at: 'desc' }, { lot_status_event_id: 'desc' }]);
  });

  // ⭐ R-3 — `sourceDocumentTypeCode` 는 널이 아니라 «키 생략»(계약 enum 3값에 널이 없다).
  //    짝 `sourceDocumentId` 도 `ck_lot_status_event_source` 로 함께 뺀다. `fromStatusCode` 도
  //    같은 관행(최초 등록 전이 C4 는 값이 없다).
  it('`fromStatusCode`·`sourceDocumentTypeCode`·`sourceDocumentId` 가 NULL 이면 키를 생략한다(C4)', () => {
    const view = lotStatusEventView(row());

    expect(Object.keys(view)).not.toContain('fromStatusCode');
    expect(Object.keys(view)).not.toContain('sourceDocumentTypeCode');
    expect(Object.keys(view)).not.toContain('sourceDocumentId');
    expect(Object.keys(view)).not.toContain('reason');
    expect(view).toEqual({
      lotStatusHistoryId: 77,
      lotId: 12,
      lotNo: 'LOT-0001',
      toStatusCode: 'INSPECTION_PENDING',
      transitionCode: 'C4',
      changedBy: 5,
      changedAt: CHANGED_AT.toISOString(),
    });
  });

  it('값이 있으면 그대로 싣는다(C7 · 검사 결과가 일으킨 전이)', () => {
    const view = lotStatusEventView(
      row({
        previous_status_code: 'INSPECTION_PENDING',
        new_status_code: 'NORMAL',
        transition_code: 'C7',
        reason: '재판정 합격',
        source_document_type_code: 'INSPECTION_RESULT',
        source_document_id: 900n,
      }),
    );

    expect(view).toMatchObject({
      fromStatusCode: 'INSPECTION_PENDING',
      toStatusCode: 'NORMAL',
      transitionCode: 'C7',
      reason: '재판정 합격',
      sourceDocumentTypeCode: 'INSPECTION_RESULT',
      sourceDocumentId: 900,
    });
  });
});
