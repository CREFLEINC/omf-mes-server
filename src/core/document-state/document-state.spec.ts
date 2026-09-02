import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from './document-state.service';
import { TRANSITIONS } from './transitions';

const LIFECYCLE = 'trace.lot.lifecycle_status_code';

describe('DocumentStateService', () => {
  const service = new DocumentStateService();

  describe('LOT 생명주기 — 지금 등록된 유일한 상태기계', () => {
    it('대기 → 활성 (L1, 첫 실적)', () => {
      expect(service.assertTransition(LIFECYCLE, 'production-result-recorded', 'WAITING')).toEqual({
        from: ['WAITING'],
        to: 'ACTIVE',
        transitionCode: 'L1',
      });
    });

    it('대기 → 폐번 (L2, 마감 — 실적 없는 슬롯)', () => {
      expect(service.assertTransition(LIFECYCLE, 'work-order-close', 'WAITING').to).toBe('VOIDED');
    });

    it('⭐ 활성 → 폐번 (L3, 작업지시 취소) — DR-007 이 R82 와 대상 집합을 가른다', () => {
      const transition = service.assertTransition(LIFECYCLE, 'work-order-cancel', 'ACTIVE');

      expect(transition).toMatchObject({ to: 'VOIDED', transitionCode: 'L3' });
    });

    it('⛔ 마감은 활성 슬롯을 폐번하지 않는다 — R82 는 「실적 없는 슬롯만」이다', () => {
      expect(() => service.assertTransition(LIFECYCLE, 'work-order-close', 'ACTIVE')).toThrow(
        ContractException,
      );
    });

    it('⛔ 폐번에서는 아무 데도 못 간다 — 재사용 금지', () => {
      for (const action of ['production-result-recorded', 'work-order-close', 'work-order-cancel']) {
        expect(() => service.assertTransition(LIFECYCLE, action, 'VOIDED')).toThrow(
          ContractException,
        );
      }
    });
  });

  describe('판정할 수 없음을 통과로 처리하지 않는다 (F-6)', () => {
    it('⛔ 등록되지 않은 칸은 던진다', () => {
      expect(() => service.assertTransition('logistics.goods_issue.status_code', 'post', 'DRAFT'))
        .toThrow(/상태 전이가 등록되지 않았다/);
    });

    it('⛔ 등록된 칸이라도 모르는 액션이면 던진다', () => {
      expect(() => service.assertTransition(LIFECYCLE, 'no-such-action', 'WAITING')).toThrow(
        /상태 전이가 등록되지 않았다/,
      );
    });

    it('⛔ 그 던짐은 ContractException 이 아니다 — 사용자 문구가 아니라 구현이 멈출 자리다', () => {
      let caught: unknown;
      try {
        service.assertTransition('없는.칸', 'x', 'Y');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ContractException);
    });
  });

  describe('열리지 않은 전이는 409 STATE_LOCKED', () => {
    it('지금 상태가 from 에 없으면 409 를 던진다', () => {
      let caught: ContractException | undefined;
      try {
        service.assertTransition(LIFECYCLE, 'production-result-recorded', 'ACTIVE');
      } catch (error) {
        caught = error as ContractException;
      }

      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(caught?.errors).toMatchObject([
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED },
      ]);
    });

    it('재로드로 풀리는 저장 충돌과 구분된다 — STATE_LOCKED 는 그 계열이다 (G-1)', () => {
      expect(ERROR_CODE.STATE_LOCKED).toBe('STATE_LOCKED');
    });
  });

  describe('등록 범위를 명시로 지킨다', () => {
    it('⛔ 품질 판정 축은 등록돼 있지 않다 — 판정 유형 값 목록이 회신 E-3 대기다', () => {
      expect(TRANSITIONS['trace.lot.status_code']).toBeUndefined();
    });

    it('⛔ is_active 토글은 상태기계가 아니다 — activate/deactivate 가 없다', () => {
      const actions = service.registered().map((entry) => entry.action);

      expect(actions).not.toContain('activate');
      expect(actions).not.toContain('deactivate');
    });

    it('지금 서 있는 것은 생명주기 축 하나다 — 늘면 이 수치가 오른다', () => {
      const columns = new Set(service.registered().map((entry) => entry.column));

      expect([...columns]).toEqual([LIFECYCLE]);
      expect(service.registered()).toHaveLength(3);
    });
  });
});
