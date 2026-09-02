import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';

/** 계층을 스스로 읽고 쓰는 한 자원의 최소 형태. 불량코드·원인코드가 같은 모양이다. */
export interface TwoLevelNode {
  id: number;
  parentId: number | null;
  hasChildren: boolean;
}

/**
 * 2계층을 지킨다 — 설계 결정 12 가 「대분류 · 상세」 두 층으로 못박았다.
 *
 * ⛔ **DB 가 아무것도 막지 않는다.** 계약이 그것을 적었다 — 「`ck_*_parent` 자기참조
 * CHECK 가 없다. `department` 에만 있고 `location`·`defect_code` 엔 둘 다 없다(#64)」.
 * 그래서 셋 다 서버가 본다.
 *
 *   1. 자기 자신을 상위로 — 계층이 자기를 가리켜 화면이 무한히 돈다.
 *   2. 상위가 이미 상세 — 3계층이 된다.
 *   3. 자기에게 하위가 있는데 상위를 붙임 — 하위가 3계층이 된다.
 *
 * 3번을 빠뜨리기 쉽다. 1·2 만 보면 「대분류 A(하위 있음)에 대분류 B 를 상위로」가 통과해
 * A 의 하위들이 소리 없이 3계층이 된다.
 */
export function assertTwoLevel(field: string, self: TwoLevelNode | null, parent: TwoLevelNode): void {
  const fail = (message: string): never => {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field, code: ERROR_CODE.INVALID, message },
    ]);
  };

  if (self !== null && parent.id === self.id) fail('자기 자신을 상위로 지정할 수 없습니다.');
  if (parent.parentId !== null) fail('상세 코드를 상위로 지정할 수 없습니다 — 2계층까지입니다.');
  if (self !== null && self.hasChildren) {
    fail('하위 코드가 있는 대분류에는 상위를 지정할 수 없습니다 — 2계층까지입니다.');
  }
}
