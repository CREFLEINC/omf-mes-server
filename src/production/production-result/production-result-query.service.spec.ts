import { pageRequest } from '../../common/pagination';
import { PRODUCTION_RESULT_ORDER_BY, buildProductionResultWhere } from './production-result-query.service';

describe('생산 실적 목록 질의 (I-7 PR ①)', () => {
  it('where — 질의 8개가 각각 자기 칸으로 간다', () => {
    const where = buildProductionResultWhere({
      workOrderId: 900,
      workSessionId: 12,
      shiftId: 3,
      equipmentId: 44,
      occurredFrom: '2026-09-06T00:00:00.000Z',
      occurredTo: '2026-09-06T23:59:59.000Z',
      page: 2,
      size: 20,
    });

    expect(where).toEqual({
      work_order_id: 900,
      work_session_id: 12,
      shift_id: 3,
      equipment_id: 44,
      // ⚠ 끝은 «닫힌» 구간이다 — 계약이 반열림이라 적은 description 이 없다.
      occurred_at: { gte: new Date('2026-09-06T00:00:00.000Z'), lte: new Date('2026-09-06T23:59:59.000Z') },
    });
    // 남은 둘은 where 가 아니라 쪽 요청으로 간다.
    expect(pageRequest({ page: 2, size: 20 })).toMatchObject({ skip: 20, take: 20 });
  });

  it('where — 값 없는 질의는 키를 안 넣고, 기간을 비워도 조건이 서지 않는다', () => {
    // ⛔ 기간 강제가 없다 — 계약이 required 로 적지 않았다(감사 조회가 아니다).
    expect(buildProductionResultWhere({})).toEqual({});
    expect(buildProductionResultWhere({ occurredFrom: '2026-09-06T00:00:00.000Z' })).toEqual({
      occurred_at: { gte: new Date('2026-09-06T00:00:00.000Z') },
    });
  });

  it('정렬 — 기본이 `occurred_at desc` 이고 동률은 PK 로 닫는다', () => {
    // 정렬 질의가 계약에 없어 서버가 고정한다 — 400 갈래도 없다.
    expect(PRODUCTION_RESULT_ORDER_BY).toEqual([{ occurred_at: 'desc' }, { production_result_id: 'desc' }]);
  });
});
