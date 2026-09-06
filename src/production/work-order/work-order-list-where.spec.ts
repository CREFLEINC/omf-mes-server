import { ContractException } from '../../common/errors';
import { RELEASABLE_ELIGIBLE_WHERE, buildOrderBy, buildWorkOrderWhere } from './work-order-list-where';

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
    it('정렬 — 허용 키 넷 밖은 400 이다', () => {
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
});
