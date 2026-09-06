import { HttpStatus } from '@nestjs/common';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { ContractRegistry } from '../../common/contract';
import { DocumentStateService } from './document-state.service';
import { TRANSITIONS } from './transitions';

const LIFECYCLE = 'trace.lot.lifecycle_status_code';
const ROUTING_COLUMN = 'planning.routing.status_code';
/** 설비 자산 수명주기 — 시드 EQUIPMENT_STATUS 가 두 값을 확정했다(#124). */
const EQUIPMENT_STATUS = 'mdm.equipment.status_code';
/** 툴도 같은 값 목록을 쓴다 — 계약이 「설비·툴·계측기가 같은 규칙」이라 적었다. */
const MOLD_STATUS = 'mdm.mold.status_code';
/** 결재 요청 진행 — 시드 APPROVAL_REQUEST_STATUS(PENDING·APPROVED·REJECTED). */
const APPROVAL_STATUS = 'app.approval_request.status_code';
/** I-4 가 여는 축. 취소 두 액션을 I-5 PR ④ 가 «이 키 안에» 더했다(I-4.md R-2). */
const GOODS_ISSUE_STATUS = 'logistics.goods_issue.status_code';
/** I-5 PR ④ 가 여는 두 축 — 취소 두 액션만 갖는다(다형 취소 경로 3유형 · I-5.md §6-1). */
const INBOUND_RECEIPT_STATUS = 'logistics.inbound_receipt.status_code';
const GOODS_RECEIPT_STATUS = 'logistics.goods_receipt.status_code';
/** I-6 PR ④ 가 여는 축 — 액션 다섯. I-11 PR ② 가 같은 키에 `work-session-start` 를 더했다. */
const WORK_ORDER_STATUS = 'production.work_order.status_code';
/** I-11 PR ② 가 여는 축 — 시드 `WORK_SESSION_STATUS`(RUNNING·STOPPED·ENDED) 3값. */
const WORK_SESSION_STATUS = 'production.work_session.status_code';

describe('DocumentStateService', () => {
  const service = new DocumentStateService();

  describe('LOT 생명주기 — 지금 등록된 유일한 상태기계', () => {
    it('대기 → 활성 (L1, 첫 실적)', () => {
      expect(service.assertTransition(LIFECYCLE, 'production-result-recorded', 'WAITING')).toMatchObject(
        { from: ['WAITING'], to: 'ACTIVE', transitionCode: 'L1' },
      );
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
        ConflictException,
      );
    });

    it('⛔ 폐번에서는 아무 데도 못 간다 — 재사용 금지', () => {
      for (const action of ['production-result-recorded', 'work-order-close', 'work-order-cancel']) {
        expect(() => service.assertTransition(LIFECYCLE, action, 'VOIDED')).toThrow(
          ConflictException,
        );
      }
    });
  });

  describe('작업지시 진행 — I-6 이 여는 축', () => {
    it('전이 — `:hold` 는 `RELEASED`·`IN_PROGRESS` 에서만 열린다', () => {
      for (const from of ['RELEASED', 'IN_PROGRESS']) {
        expect(service.assertTransition(WORK_ORDER_STATUS, 'work-order-hold', from).to).toBe(
          'SUSPENDED',
        );
      }
      // `PLANNED`·`CONFIRMED` 는 아직 배포 전이라 중단할 것이 없다.
      for (const from of ['PLANNED', 'CONFIRMED', 'SUSPENDED', 'CLOSED']) {
        expect(() =>
          service.assertTransition(WORK_ORDER_STATUS, 'work-order-hold', from, HttpStatus.BAD_REQUEST),
        ).toThrow(ContractException);
      }
    });

    it('전이 — 등록되지 않은 (칸, 액션) 은 던진다', () => {
      // `:release` 는 ⑤b 가 부르지만 키는 여기서 다 열었다 — 없는 것은 아직 안 정한 액션이다.
      expect(service.assertTransition(WORK_ORDER_STATUS, 'work-order-release', 'PLANNED').to).toBe(
        'RELEASED',
      );
      expect(() =>
        service.assertTransition(WORK_ORDER_STATUS, 'work-order-complete', 'IN_PROGRESS'),
      ).toThrow(/상태 전이가 등록되지 않았다/);
    });

    it('전이 — `from` 밖이면 400 `STATE_LOCKED` 이고 409 가 아니다', () => {
      let caught: ContractException | undefined;
      try {
        service.assertTransition(
          WORK_ORDER_STATUS,
          'work-order-resume',
          'RELEASED',
          HttpStatus.BAD_REQUEST,
        );
      } catch (error) {
        caught = error as ContractException;
      }

      expect(caught?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(caught).not.toBeInstanceOf(ConflictException);
      expect(caught?.errors).toMatchObject([{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED }]);
    });

    it('work-session-start 는 RELEASED·IN_PROGRESS 에서 IN_PROGRESS 로 간다', () => {
      for (const from of ['RELEASED', 'IN_PROGRESS']) {
        expect(service.assertTransition(WORK_ORDER_STATUS, 'work-session-start', from).to).toBe(
          'IN_PROGRESS',
        );
      }
    });

    it('work-session-start 는 SUSPENDED 에서 던진다 — 재개는 같은 세션의 RESUME 뿐이다', () => {
      expect(() =>
        service.assertTransition(
          WORK_ORDER_STATUS,
          'work-session-start',
          'SUSPENDED',
          HttpStatus.BAD_REQUEST,
        ),
      ).toThrow(ContractException);
    });
  });

  describe('작업 세션 진행 — I-11 이 여는 축', () => {
    it('세션 키 — STOP 은 RUNNING 에서만, RESUME 은 STOPPED 에서만이다', () => {
      expect(service.assertTransition(WORK_SESSION_STATUS, 'work-session-stop', 'RUNNING').to).toBe(
        'STOPPED',
      );
      expect(
        service.assertTransition(WORK_SESSION_STATUS, 'work-session-resume', 'STOPPED').to,
      ).toBe('RUNNING');
      for (const [action, from] of [
        ['work-session-stop', 'STOPPED'],
        ['work-session-stop', 'ENDED'],
        ['work-session-resume', 'RUNNING'],
        ['work-session-resume', 'ENDED'],
      ]) {
        expect(() =>
          service.assertTransition(WORK_SESSION_STATUS, action, from, HttpStatus.BAD_REQUEST),
        ).toThrow(ContractException);
      }
    });

    it('세션 키 — END 는 RUNNING·STOPPED 둘 다에서 ENDED 로 간다', () => {
      for (const from of ['RUNNING', 'STOPPED']) {
        expect(service.assertTransition(WORK_SESSION_STATUS, 'work-session-end', from).to).toBe(
          'ENDED',
        );
      }
      expect(() =>
        service.assertTransition(
          WORK_SESSION_STATUS,
          'work-session-end',
          'ENDED',
          HttpStatus.BAD_REQUEST,
        ),
      ).toThrow(ContractException);
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

  describe('열리지 않은 전이 — 봉투가 상태마다 다르다', () => {
    it('409 는 계약 ConflictResponse 다 — errors 배열이 아니다', () => {
      let caught: ConflictException | undefined;
      try {
        service.assertTransition(LIFECYCLE, 'production-result-recorded', 'ACTIVE');
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(caught?.conflict.conflictCause).toBe('user');
      expect(caught?.getResponse()).not.toHaveProperty('errors');
    });

    it('⭐ 400 은 ErrorResponse 다 — 계약이 자리마다 다르게 선언했다', () => {
      let caught: ContractException | undefined;
      try {
        service.assertTransition(
          LIFECYCLE,
          'production-result-recorded',
          'ACTIVE',
          HttpStatus.BAD_REQUEST,
        );
      } catch (error) {
        caught = error as ContractException;
      }

      expect(caught?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(caught?.errors).toMatchObject([{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED }]);
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

    it('⭐ 전이를 여는 계약 오퍼레이션이 전부 실재한다 — 이름이 계약과 이어져 있다', () => {
      // 액션 이름은 설명적이라 계약의 동사와 다르다(전이를 «일으키는» 자원과 상태 칸을
      // 가진 자원이 다르기 때문). 그 연결이 끊기지 않았는지 계약 원본으로 확인한다.
      const registry = ContractRegistry.load();
      const missing = service
        .registered()
        .map((entry) => entry.transition.sourceOperation)
        .filter((operation) => !registry.has(operation));

      expect(missing).toEqual([]);
    });

    it('지금 서 있는 상태 축과 전이 수 — 늘면 이 검사가 먼저 깨진다', () => {
      // ⛔ 「늘었으니 고친다」가 아니라 「늘려도 되나」를 한 번 묻게 하는 자리다.
      // 값 목록 없이 전이를 지어내는 것을 F-6 이 금지하므로, 등록은 항상 의도적이어야 한다.
      const columns = new Set(service.registered().map((entry) => entry.column));

      expect([...columns].sort()).toEqual(
        [
          APPROVAL_STATUS,
          EQUIPMENT_STATUS,
          GOODS_ISSUE_STATUS,
          GOODS_RECEIPT_STATUS,
          INBOUND_RECEIPT_STATUS,
          LIFECYCLE,
          MOLD_STATUS,
          ROUTING_COLUMN,
          WORK_ORDER_STATUS,
          WORK_SESSION_STATUS,
        ].sort(),
      );
      // +6 — 출고 키에 취소 2, 입하·입고 키가 각각 2(I-5 PR ④).
      // +5 — W/O 키(I-6 PR ④).
      // +4 — W/O 키에 세션 시작 1, 세션 키 신설 3(I-11 PR ②).
      expect(service.registered()).toHaveLength(25);
    });
  });
});
