import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { ActionName, StateColumn, Transition, TransitionRegistry } from './document-state.types';
import { TRANSITIONS } from './transitions';

export interface RegisteredTransition {
  column: StateColumn;
  action: ActionName;
  transition: Transition;
}

/**
 * 전표 상태 전이를 한자리에서 가른다. `status_code` 를 가진 표가 **61개**라
 * 각자 `if` 를 쓰면 61가지 규칙이 흩어진다.
 */
@Injectable()
export class DocumentStateService {
  constructor(private readonly registry: TransitionRegistry = TRANSITIONS) {}

  /**
   * 지금 상태에서 그 액션이 열리는지 가르고, 열리면 다음 상태를 준다.
   *
   * ⛔ 등록되지 않은 (칸, 액션) 은 **던진다.** 계약이 이 자리에 409 를 선언해 두었는데,
   * 값 목록 없이 통과시키면 「아무 전이나 된다」와 같아진다(공유계약 F-6).
   */
  assertTransition(column: StateColumn, action: ActionName, currentStatus: string): Transition {
    const transition = this.registry[column]?.[action];
    if (!transition) {
      // 업무 오류가 아니라 «우리가 아직 안 정한 것»이다 — 사용자에게 보일 문구가 아니라
      // 구현이 멈춰야 하는 자리라 예외로 던진다.
      throw new Error(
        `상태 전이가 등록되지 않았다: ${column} / ${action} — ` +
          '값 목록이 오면 transitions.ts 에 더한다 (공유계약 F-6)',
      );
    }

    if (!transition.from.includes(currentStatus)) {
      throw new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'screen',
          // 재로드해도 풀리지 않는다 — 저장 충돌(409)과 구분한다(공유계약 G-1).
          code: ERROR_CODE.STATE_LOCKED,
          message: `지금 상태(${currentStatus})에서는 할 수 없습니다.`,
        },
      ]);
    }

    return transition;
  }

  /** 계약의 액션형 오퍼레이션 109건 중 몇이 서 있나 — 진도를 센다. */
  registered(): RegisteredTransition[] {
    return Object.entries(this.registry).flatMap(([column, actions]) =>
      Object.entries(actions).map(([action, transition]) => ({ column, action, transition })),
    );
  }
}
