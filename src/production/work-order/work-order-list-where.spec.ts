import { ContractException } from '../../common/errors';
import { Prisma } from '@prisma/client';
import { RELEASABLE_ELIGIBLE_WHERE, achievementOrderedIds, achievementSortDirection,
  buildOrderBy, buildWorkOrderWhere } from './work-order-list-where';

describe('work-order-list-where', () => {
  describe('buildWorkOrderWhere', () => {
    it('where — released=false 는 released_at IS NULL 이고 미지정과 다르다', () => {
      expect(buildWorkOrderWhere({ released: false })).toEqual({ AND: [{ released_at: null }] });
      // 미지정은 그 축을 아예 안 건다 — false 와 같은 뜻이 아니다.
      expect(buildWorkOrderWhere({})).toEqual({});
    });

    it('where — open 은 배포·완료·마감 시각과 취소 «상태»를 함께 본다', () => {
      expect(buildWorkOrderWhere({ open: true })).toEqual({
        AND: [
          {
            released_at: { not: null },
            completed_at: null,
            closed_at: null,
            NOT: { status_code: 'CANCELLED' },
          },
        ],
      });
      // false 는 그 조건 전체의 부정이다(취소 상태 하나만 보는 게 아니다).
      expect(buildWorkOrderWhere({ open: false })).toEqual({
        AND: [
          {
            NOT: {
              released_at: { not: null },
              completed_at: null,
              closed_at: null,
              NOT: { status_code: 'CANCELLED' },
            },
          },
        ],
      });
    });

    it('where — releasable 은 긴급 유형을 뺀다', () => {
      // releasable 자신은 where 밖(서비스가 후보를 좁힌다) — 유형 제외는 상수에 실린다.
      expect(RELEASABLE_ELIGIBLE_WHERE).toMatchObject({ work_order_type_code: { not: 'EMERGENCY' } });
    });

    it('where — held 는 SUSPENDED 로 근사한다(설계 미정 — 문의 035)', () => {
      expect(buildWorkOrderWhere({ held: true })).toEqual({ AND: [{ status_code: 'SUSPENDED' }] });
      expect(buildWorkOrderWhere({ held: false })).toEqual({ AND: [{ status_code: { not: 'SUSPENDED' } }] });
    });

    it('where — processId 는 routing_operation 조인으로 푼다', () => {
      expect(buildWorkOrderWhere({ processId: 77 })).toEqual({
        AND: [{ routing_operation: { process_id: 77 } }],
      });
    });

    it('where — productionOrderId 는 계획을 경유한다', () => {
      expect(buildWorkOrderWhere({ productionOrderId: 55 })).toEqual({
        AND: [{ production_plan: { production_order_id: 55 } }],
      });
    });
  });

  describe('buildOrderBy', () => {
    it('Prisma 직접 정렬에 파생 달성률 키를 넘기면 400 이다', () => {
      expect(() => buildOrderBy('achievementRate,desc')).toThrow(ContractException);
      try {
        buildOrderBy('achievementRate,desc');
      } catch (error) {
        expect((error as ContractException).getStatus()).toBe(400);
        expect((error as ContractException).getResponse()).toMatchObject({ errors: [{ field: 'sort', code: 'INVALID' }] });
      }
    });

    it('정렬 — 프로토타입 체인 키는 400 이다', () => {
      expect(() => buildOrderBy('toString')).toThrow(ContractException);
      expect(() => buildOrderBy('constructor')).toThrow(ContractException);
    });

    it('정렬 — 동률은 PK 오름차순으로 닫는다', () => {
      expect(buildOrderBy(undefined)).toEqual([{ priority_no: 'asc' }, { work_order_id: 'asc' }]);
      expect(buildOrderBy('workOrderNo,desc')).toEqual([{ work_order_no: 'desc' }, { work_order_id: 'asc' }]);
    });
  });

  describe('achievementRate sort', () => {
    const period = { plannedStartFrom: '2026-09-01T00:00:00+09:00',
      plannedStartTo: '2026-10-01T00:00:00+09:00' };

    it('기간이 좁을 때만 허용하며 넓거나 미지정이면 400이다', () => {
      expect(achievementSortDirection({ ...period, sort: 'achievementRate,desc' })).toBe('desc');
      expect(achievementSortDirection({ ...period, sort: 'achievementRate' })).toBe('asc');
      expect(achievementSortDirection({ ...period, sort: 'priorityNo,asc' })).toBeNull();
      expect(() => achievementSortDirection({ sort: 'achievementRate,desc' })).toThrow(ContractException);
      expect(() => achievementSortDirection({ ...period,
        plannedStartTo: '2027-01-01T00:00:00+09:00', sort: 'achievementRate,desc' })).toThrow(ContractException);
    });

    it('필터된 전체 집합의 실적합/지시량으로 정렬하고 동률은 ID순이다', () => {
      const decimal = (value: number) => new Prisma.Decimal(value);
      const candidates = [
        { work_order_id: 3n, order_qty: decimal(100) },
        { work_order_id: 1n, order_qty: decimal(10) },
        { work_order_id: 2n, order_qty: decimal(20) },
      ];
      const good = new Map<bigint, Prisma.Decimal | null>([[3n, decimal(50)], [1n, decimal(5)]]);
      expect(achievementOrderedIds(candidates, good, 'desc')).toEqual([1n, 3n, 2n]);
      expect(achievementOrderedIds(candidates, good, 'asc')).toEqual([2n, 1n, 3n]);
    });
  });
});
