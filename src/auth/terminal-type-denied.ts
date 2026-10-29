import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../common/errors';
import { OPERATION_PERMISSIONS } from '../common/permissions/operation-permissions';
import { PERMISSIONS } from '../common/permissions/permissions';

type TerminalType = 'POP' | 'MOBILE';

const TYPE_LABEL: Readonly<Record<TerminalType, string>> = { POP: 'POP 단말', MOBILE: 'PDA(모바일 단말)' };
/** 화면 코드 머리가 단말 유형을 말한다 — `P-` 는 POP, `M-` 는 PDA 화면이다(권한 목록 · 화면 코드 = 권한 코드). */
const SCREEN_PREFIX: Readonly<Record<TerminalType, string>> = { POP: 'P-', MOBILE: 'M-' };
const NAME_OF = new Map(PERMISSIONS.map((permission) => [permission.code, permission.name]));

/**
 * 단말 토큰은 맞는데 그 유형이 이 경로를 쓸 수 없을 때 — 「로그인이 필요합니다」는 원인을 틀리게 알려 화면이 재로그인을 권한다.
 * 그 경로를 부르는 맞는 단말의 화면을 권한 표(오퍼레이션 → 화면 코드 → 이름)에서 찾아 조치로 싣는다. 상태는 401 그대로다.
 */
export function wrongTerminalType(key: string, allowed: readonly TerminalType[], actual: string): ContractException {
  const where = allowed.map((type) => TYPE_LABEL[type]).join('·');
  const screen = (OPERATION_PERMISSIONS[key] ?? []).find((code) => allowed.some((type) => code.startsWith(SCREEN_PREFIX[type])));
  const actualLabel = TYPE_LABEL[actual as TerminalType] ?? actual;
  const action = screen === undefined
    ? `${where}에서 하세요.`
    : `${TYPE_LABEL[allowed.find((type) => screen.startsWith(SCREEN_PREFIX[type])) as TerminalType]} ${NAME_OF.get(screen) ?? ''}(${screen})에서 하세요.`;
  return new ContractException(HttpStatus.UNAUTHORIZED, [{
    scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED,
    message: `이 기능은 ${where}에서만 쓸 수 있습니다(지금 단말: ${actualLabel}) — ${action}`,
  }]);
}
