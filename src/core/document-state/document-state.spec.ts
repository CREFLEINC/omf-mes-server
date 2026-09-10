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
/** I-12 PR ① 이 여는 축 — 시드 `PUTAWAY_TASK_STATUS`(PENDING·COMPLETED·COMPLETED_TEMPORARY) 3값. */
const PUTAWAY_TASK_STATUS = 'logistics.putaway_task.status_code';
/** I-24 PR ③ 이 여는 축 — 시드 `PRODUCTION_PLAN_STATUS`(DRAFT·CONFIRMED) 2값. */
const PRODUCTION_PLAN_STATUS = 'planning.production_plan.status_code';
/** I-19 PR ① 이 여는 축 — 시드 `INSPECTION_RESULT_STATUS`(DRAFT·CONFIRMED) 2값. */
const INSPECTION_RESULT_STATUS = 'quality.inspection_result.status_code';
/** I-19 PR ① 이 여는 축 — 시드 `LOT_STATUS` 4값. 같은 표의 생명주기 축과 «다른 칸»이다. */
const LOT_QUALITY_STATUS = 'trace.lot.status_code';
/** I-30이 여는 고장 처리 축 — RECEIVED→HANDLING→DONE, RECEIVED→DONE. */
const BREAKDOWN_STATUS = 'maintenance.breakdown.status_code';
/** I-31 C0이 여는 축 — 발행된 보전 지시만 취소할 수 있다. */
const MAINTENANCE_ORDER_STATUS = 'maintenance.maintenance_order.status_code';
/** I-13 PR ③ 이 여는 축 — 시드 `LOGISTICS_DOCUMENT_STATUS`. 도착 확정 하나뿐이다. */
const SHIPMENT_STATUS = 'logistics.shipment.status_code';
const STOCK_TRANSFER_STATUS = 'logistics.stock_transfer.status_code';
/** I-21 PR ④ 가 여는 축 — 시드 `NONCONFORMANCE_STATUS` 3값. 의뢰와 판정 완료 둘뿐이다. */
const NONCONFORMANCE_STATUS = 'quality.nonconformance.status_code';
/** I-14 PR ④ 가 여는 축 — 시드 `LOGISTICS_DOCUMENT_STATUS`. 전기 하나뿐이다(취소 경로 0건). */
const ADJUSTMENT_STATUS = 'inventory.inventory_adjustment.status_code';

/**
 * ⭐ **등록된 축 전건.** 위 상수 하나하나가 「어느 슬라이스가 열었나」를 달고 있다 — 그 목록이
 * 곧 표다. ⛔ `transitions.ts` 머리 주석이 수를 글로 적고 있었고 **「일곱」인 채로 열아홉이 되도록
 * 아무도 몰랐다**(부채 #337). 그래서 수를 주석이 아니라 여기서 «센다».
 */
const REGISTERED_AXES = [
  ADJUSTMENT_STATUS,
  APPROVAL_STATUS,
  BREAKDOWN_STATUS,
  EQUIPMENT_STATUS,
  GOODS_ISSUE_STATUS,
  GOODS_RECEIPT_STATUS,
  INBOUND_RECEIPT_STATUS,
  INSPECTION_RESULT_STATUS,
  LIFECYCLE,
  LOT_QUALITY_STATUS,
  MAINTENANCE_ORDER_STATUS,
  MOLD_STATUS,
  NONCONFORMANCE_STATUS,
  PRODUCTION_PLAN_STATUS,
  PUTAWAY_TASK_STATUS,
  ROUTING_COLUMN,
  SHIPMENT_STATUS,
  STOCK_TRANSFER_STATUS,
  WORK_ORDER_STATUS,
  WORK_SESSION_STATUS,
];

describe('DocumentStateService', () => {
  const service = new DocumentStateService();

  it('⭐ 등록된 축이 이 파일이 이름 적은 축과 «같다» — 수는 여기서 세지 않는다', () => {
    // ⛔ 축을 더했으면 위 상수 목록에도 더한다 — 여기 없는 축은 이 spec 이 한 번도 안 만져 본
    //    축이고, `test/document-state.e2e-spec.ts` 의 `STATUS_GROUPS` 도 못 채웠을 가능성이
    //    높다(README §6-4 — 그 표가 안 채워져 main 이 두 번 빨갰다).
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...REGISTERED_AXES].sort());
  });

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

  describe('설비 고장 처리 — I-30이 여는 축', () => {
    it('처리 시작은 RECEIVED에서만 HANDLING으로 간다', () => {
      expect(
        service.assertTransition(
          BREAKDOWN_STATUS,
          'breakdown-start-handling',
          'RECEIVED',
          HttpStatus.BAD_REQUEST,
        ),
      ).toMatchObject({ from: ['RECEIVED'], to: 'HANDLING' });

      for (const from of ['HANDLING', 'DONE']) {
        expect(() =>
          service.assertTransition(
            BREAKDOWN_STATUS,
            'breakdown-start-handling',
            from,
            HttpStatus.BAD_REQUEST,
          ),
        ).toThrow(ContractException);
      }
    });

    it('완료는 RECEIVED·HANDLING에서 DONE으로 가고 DONE은 잠긴다', () => {
      for (const from of ['RECEIVED', 'HANDLING']) {
        expect(
          service.assertTransition(
            BREAKDOWN_STATUS,
            'breakdown-complete',
            from,
            HttpStatus.BAD_REQUEST,
          ).to,
        ).toBe('DONE');
      }
      expect(() =>
        service.assertTransition(
          BREAKDOWN_STATUS,
          'breakdown-complete',
          'DONE',
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

  describe('LOT 품질 판정 축 — I-19 가 여는 축', () => {
    const from = (action: string) => [...TRANSITIONS[LOT_QUALITY_STATUS][action].from].sort();

    it('⭐ 불량(Hold) 발신은 재등록과 처분 셋뿐이다 — 검사·보류 여덟은 DEFECTIVE 를 안 받는다', () => {
      // 계약이 두 자리에 이름 적었다: 「불량(Hold)은 발신 전이가 0」(quality-03품질.json)
      // · 「⭐ 이 경로에서만 반영 목적의 Hold → 정상 전이가 허용된다」(shipment-04제품출하.json
      // · 공유계약 B-13). 그래서 `from` 을 한 상수로 묶지 않고 액션마다 가른다.
      // ⭐ 처분 판정 화면 `W-03-10` 은 그 도식보다 «나중»(DR-008 확정 3-A)이라 예외가 넷이 됐다
      // (결정 — 통보 089 §1).
      const withDefective = service
        .registered()
        .filter((entry) => entry.column === LOT_QUALITY_STATUS)
        .filter((entry) => entry.transition.from.includes('DEFECTIVE'))
        .map((entry) => entry.action)
        .sort();

      expect(withDefective).toEqual([
        'disposition-normal',
        'disposition-rework',
        'disposition-scrap',
        'stock-reinstate',
      ]);
      // ⭐ I-23 이 셋으로 넓혔다 — 코어가 `from` 밖을 «던지지 않고 skip» 해서, 좁으면 400 이
      //    아니라 응답 `lotStatusCode` 가 조용히 거짓이 된다(통보 218). 반품 갈래가
      //    `INSPECTION_PENDING` 으로 들어온다. ⛔ `SCRAPPED` 는 없다.
      // ⚠ `from` 헬퍼가 정렬해 돌려준다 — 선언 순서가 아니라 사전순이다.
      expect(from('stock-reinstate')).toEqual(['DEFECTIVE', 'INSPECTION_PENDING', 'NORMAL']);
      // ⛔ 폐기된 LOT 은 되살리지 않는다 — 재등록은 그 오퍼레이션이 아니다.
      expect(from('stock-reinstate')).not.toContain('SCRAPPED');
      // 불합격은 «자기 자신»으로도 못 간다 — 자기 전이도 발신이다.
      expect(() =>
        service.assertTransition(LOT_QUALITY_STATUS, 'inspection-rejected', 'DEFECTIVE'),
      ).toThrow(ConflictException);
    });

    it('검사 확정 넷은 NORMAL·INSPECTION_PENDING 에서 출발한다 — 재검·OQC 가 막히지 않는다', () => {
      // 좁혀서 `INSPECTION_PENDING` 하나로 두면 ⓐ 재검 회차 확정과 ⓑ PQC 를 지나 이미
      // `NORMAL` 인 제품LOT 의 OQC 확정이 통째로 막힌다.
      for (const action of [
        'inspection-accepted',
        'inspection-held',
        'inspection-rejected',
        'pqc-acceptance-exceeded',
      ]) {
        expect(from(action)).toEqual(['INSPECTION_PENDING', 'NORMAL']);
      }
      expect(service.assertTransition(LOT_QUALITY_STATUS, 'inspection-accepted', 'NORMAL').to).toBe(
        'NORMAL',
      );
    });

    it('보류 축은 도식의 수신·발신 그대로다 — 재판정은 보류에서, 재Hold 는 정상에서', () => {
      expect(from('lot-hold-release-accepted')).toEqual(['INSPECTION_PENDING']);
      expect(from('lot-hold-release-rejected')).toEqual(['INSPECTION_PENDING']);
      expect(from('lot-hold-claim')).toEqual(['NORMAL']);
      expect(from('lot-hold-suspect')).toEqual(['INSPECTION_PENDING', 'NORMAL']);
    });

    it('⭐ SCRAPPED 는 도착에만 있다 — 폐기된 LOT 을 다시 옮기는 오퍼레이션이 0건이다', () => {
      // 계약이 도착 상태를 직접 적었다(`quality-03품질.json:2460`) — 없던 것은 「도착」이 아니라
      // 「전이 코드」뿐이었다(결정 — 통보 089 §1). 발신이 0인 것은 판정이다: 이미 폐기된 LOT 의
      // 처분 요청은 코어가 0건 옮기고 400 STATE_LOCKED 로 떨어진다.
      const entries = service.registered().filter((entry) => entry.column === LOT_QUALITY_STATUS);

      expect(entries.flatMap((entry) => entry.transition.from)).not.toContain('SCRAPPED');
      expect(
        entries.filter((entry) => entry.transition.to === 'SCRAPPED').map((entry) => entry.action),
      ).toEqual(['disposition-scrap']);
      expect(() =>
        service.assertTransition(LOT_QUALITY_STATUS, 'disposition-rework', 'SCRAPPED'),
      ).toThrow(ConflictException);
    });

    it('⭐ 처분 판정 셋 — 원천 둘(PRODUCT·RETURN)의 출발 상태를 다 받고 도착만 갈린다', () => {
      // 좁히면 반품 갈래 본길이 통째로 400 으로 죽는다 — RETURN 은 원 LOT 을 그대로 쓰므로
      // 출발이 NORMAL·INSPECTION_PENDING 이다(`W-04-07` §5-4 · 통보 089 §1).
      for (const action of ['disposition-rework', 'disposition-scrap', 'disposition-normal']) {
        expect(from(action)).toEqual(['DEFECTIVE', 'INSPECTION_PENDING', 'NORMAL']);
      }

      expect(
        service.assertTransition(LOT_QUALITY_STATUS, 'disposition-rework', 'DEFECTIVE'),
      ).toMatchObject({ to: 'INSPECTION_PENDING', transitionCode: 'C17' });
      expect(
        service.assertTransition(LOT_QUALITY_STATUS, 'disposition-scrap', 'NORMAL'),
      ).toMatchObject({ to: 'SCRAPPED', transitionCode: 'C18' });
      expect(
        service.assertTransition(LOT_QUALITY_STATUS, 'disposition-normal', 'INSPECTION_PENDING'),
      ).toMatchObject({ to: 'NORMAL', transitionCode: 'C19' });
    });

    it('⭐ 처분 정상과 재등록은 도착이 같아도 «다른 전이»다 — 여는 오퍼레이션이 가른다', () => {
      // R-17 · 통보 184 — 둘 다 `to: 'NORMAL'` 이고 `from` 에 `DEFECTIVE` 를 갖지만 코어는
      // (칸, 액션명)으로 찾고 두 액션의 `sourceOperation` 이 다르다. 이력도 갈린다(C19 ↔ 미정).
      const normal = TRANSITIONS[LOT_QUALITY_STATUS]['disposition-normal'];
      const reinstate = TRANSITIONS[LOT_QUALITY_STATUS]['stock-reinstate'];

      expect(normal.to).toBe(reinstate.to);
      expect(normal.sourceOperation).toBe(
        'POST /quality/nonconformances/{nonconformanceId}/disposition-decisions',
      );
      expect(reinstate.sourceOperation).toBe('POST /logistics/stock-reinstatements');
      // ⭐ I-23 이 C20 을 박았다 — 코드가 갈리는 것이 「도착이 같아도 다른 전이」의 셋째 증거다.
      expect(normal.transitionCode).toBe('C19');
      expect(reinstate.transitionCode).toBe('C20');
    });

    it('⭐ LOT 품질 축은 «전건» transitionCode 를 갖는다 — 이력 칸이 NOT NULL 이다', () => {
      // ⛔ 이 단언의 뜻이 I-23 에서 뒤집혔다: 예전엔 「재등록만 없다」였다. 계약 enum 9값에
      //    재등록 코드가 없어 호출자가 넘기게 뒀던 자리를 통보 218 이 C20 으로 확정했다.
      //    ⇒ 이제 «하나라도 비면» 그 전이는 이력 행을 세울 수 없어 런타임에 터진다.
      const withoutCode = service
        .registered()
        .filter((entry) => entry.column === LOT_QUALITY_STATUS)
        .filter((entry) => entry.transition.transitionCode === undefined)
        .map((entry) => entry.action);

      expect(withoutCode).toEqual([]);
    });
  });

  describe('부적합 처리 진행 — I-21 이 여는 축', () => {
    it('의뢰는 NOT_REQUESTED 에서만, 판정 완료는 PENDING_DECISION 에서만 열린다', () => {
      expect(
        service.assertTransition(
          NONCONFORMANCE_STATUS,
          'nonconformance-request-disposition',
          'NOT_REQUESTED',
        ),
      ).toMatchObject({ from: ['NOT_REQUESTED'], to: 'PENDING_DECISION' });
      expect(
        service.assertTransition(NONCONFORMANCE_STATUS, 'nonconformance-decide', 'PENDING_DECISION'),
      ).toMatchObject({ from: ['PENDING_DECISION'], to: 'DECIDED' });
    });

    it('⛔ 되돌리는 전이가 0이다 — 오판정 정정 오퍼레이션이 계약에 없다(W-03-10 §8 #9 미결)', () => {
      // 판정 완료는 dead end 다. 재의뢰도 없다 — 두 방향 다 `from` 에 도착 상태가 없다.
      expect(() =>
        service.assertTransition(NONCONFORMANCE_STATUS, 'nonconformance-decide', 'DECIDED'),
      ).toThrow(ConflictException);
      expect(() =>
        service.assertTransition(
          NONCONFORMANCE_STATUS,
          'nonconformance-request-disposition',
          'DECIDED',
        ),
      ).toThrow(ConflictException);
      expect(Object.keys(TRANSITIONS[NONCONFORMANCE_STATUS])).toEqual([
        'nonconformance-request-disposition',
        'nonconformance-decide',
      ]);
    });

    it('⛔ 이력 표가 없는 축이다 — transitionCode 를 안 쓴다', () => {
      const codes = Object.values(TRANSITIONS[NONCONFORMANCE_STATUS]).map(
        (transition) => transition.transitionCode,
      );

      expect(codes).toEqual([undefined, undefined]);
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
    it('보전 지시 취소는 ISSUED에서만 열고 완료 전이는 등록하지 않는다', () => {
      expect(
        service.assertTransition(MAINTENANCE_ORDER_STATUS, 'maintenance-order-cancel', 'ISSUED'),
      ).toMatchObject({ from: ['ISSUED'], to: 'CANCELLED' });
      for (const status of ['DONE', 'CANCELLED']) {
        expect(() =>
          service.assertTransition(
            MAINTENANCE_ORDER_STATUS,
            'maintenance-order-cancel',
            status,
            HttpStatus.BAD_REQUEST,
          ),
        ).toThrow(ContractException);
      }
      expect(() =>
        service.assertTransition(MAINTENANCE_ORDER_STATUS, 'maintenance-order-complete', 'ISSUED'),
      ).toThrow(/상태 전이가 등록되지 않았다/);
    });

    it('⭐ 품질 판정 축을 등록했다 — 회신 E-3 이 2026-08-07 에 종결됐다', () => {
      // 이 단언은 오래 「등록돼 있지 않다」였다. 비워 둔 이유가 판정 유형 값 목록의
      // 고객 회신 대기였고, 그 회신이 종결되며 「보류」·「PQC 검사 필요」가
      // `INSPECTION_PENDING` 하나로 합쳐져 시드 두 그룹이 맞물렸다(LOT상태-확정기록.md).
      expect(TRANSITIONS[LOT_QUALITY_STATUS]).toBeDefined();
      expect(TRANSITIONS[INSPECTION_RESULT_STATUS]).toBeDefined();
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
          ADJUSTMENT_STATUS,
          APPROVAL_STATUS,
          BREAKDOWN_STATUS,
          EQUIPMENT_STATUS,
          GOODS_ISSUE_STATUS,
          GOODS_RECEIPT_STATUS,
          INBOUND_RECEIPT_STATUS,
          INSPECTION_RESULT_STATUS,
          LIFECYCLE,
          LOT_QUALITY_STATUS,
          MAINTENANCE_ORDER_STATUS,
          MOLD_STATUS,
          NONCONFORMANCE_STATUS,
          PRODUCTION_PLAN_STATUS,
          PUTAWAY_TASK_STATUS,
          ROUTING_COLUMN,
          SHIPMENT_STATUS,
          STOCK_TRANSFER_STATUS,
          WORK_ORDER_STATUS,
          WORK_SESSION_STATUS,
        ].sort(),
      );
      // +6 — 출고 키에 취소 2, 입하·입고 키가 각각 2(I-5 PR ④).
      // +5 — W/O 키(I-6 PR ④).
      // +4 — W/O 키에 세션 시작 1, 세션 키 신설 3(I-11 PR ②).
      // +2 — 적치 지시 키 신설(I-12 PR ①).
      // +1 — 생산계획 확정 키 신설(I-24 PR ③).
      // +10 — 검사 성적서 확정 키 신설 1, LOT 품질 축 키 신설 9(I-19 PR ①).
      // +2 — 설비 고장 처리 키 신설(I-30 PR ④).
      // +1 — 보전 지시 취소 키 신설(I-31 C0).
      // +1 — 재고 이동 도착 확정 키 신설(I-13 PR ③).
      // +5 — LOT 품질 축에 처분 판정 3, 부적합 처리 키 신설 2(I-21 PR ④).
      // +1 — 재고 조정 전기 키 신설(I-14 PR ④).
      // +2 — 출하 확정·취소 키 신설(I-23 PR ③). ⛔ `:request-cancel` 은 전이가 «0개»다 —
      //      시드 SHIPMENT_STATUS 3값에 CANCEL_REQUESTED 가 없어 담을 상태가 없다.
      expect(service.registered()).toHaveLength(50);
    });

    it('⭐ 출하 상태 — 확정·취소 «둘»뿐이고 :request-cancel 은 전이가 아니다', () => {
      expect(
        service.assertTransition(SHIPMENT_STATUS, 'shipment-confirm', 'UNCONFIRMED'),
      ).toMatchObject({ to: 'CONFIRMED', from: ['UNCONFIRMED'] });
      expect(
        service.assertTransition(SHIPMENT_STATUS, 'shipment-cancel', 'UNCONFIRMED'),
      ).toMatchObject({ to: 'CANCELLED', from: ['UNCONFIRMED'] });
      // ⛔ 확정에서 되돌아오는 전이는 없다 — 계약이 「확정 취소 경로가 없다」라 적었다.
      expect(() =>
        service.assertTransition(SHIPMENT_STATUS, 'shipment-cancel', 'CONFIRMED'),
      ).toThrow(ConflictException);
      // ⛔ `:request-cancel` 은 (칸, 액션)이 «없다» — 등록되지 않은 액션은 코어가 던진다.
      expect(() =>
        service.assertTransition(SHIPMENT_STATUS, 'shipment-request-cancel', 'UNCONFIRMED'),
      ).toThrow();
    });

    it('⭐ 재고 이동 상태 — transfer-arrive «하나»뿐이고 반출은 전이가 아니다(탄생 상태)', () => {
      expect(
        service.assertTransition(STOCK_TRANSFER_STATUS, 'transfer-arrive', 'REGISTERED'),
      ).toMatchObject({ from: ['REGISTERED'], to: 'POSTED' });

      const actions = service
        .registered()
        .filter((entry) => entry.column === STOCK_TRANSFER_STATUS)
        .map((entry) => entry.action);

      expect(actions).toEqual(['transfer-arrive']);
    });

    it('⭐ 적치 지시 상태 — 완료 둘 다 dead end 다(임시→정상 복귀 오퍼레이션이 계약에 없다)', () => {
      expect(
        service.assertTransition(PUTAWAY_TASK_STATUS, 'putaway-complete', 'PENDING'),
      ).toMatchObject({ from: ['PENDING'], to: 'COMPLETED' });
      expect(
        service.assertTransition(PUTAWAY_TASK_STATUS, 'putaway-complete-temporary', 'PENDING'),
      ).toMatchObject({ from: ['PENDING'], to: 'COMPLETED_TEMPORARY' });

      const actions = service
        .registered()
        .filter((entry) => entry.column === PUTAWAY_TASK_STATUS)
        .map((entry) => entry.action);
      expect(actions.sort()).toEqual(['putaway-complete', 'putaway-complete-temporary'].sort());
      expect(() =>
        service.assertTransition(PUTAWAY_TASK_STATUS, 'putaway-complete', 'COMPLETED'),
      ).toThrow();
      expect(() =>
        service.assertTransition(PUTAWAY_TASK_STATUS, 'putaway-complete', 'COMPLETED_TEMPORARY'),
      ).toThrow();
    });
  });
});
