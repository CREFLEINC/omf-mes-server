import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../common/errors';
import { OPERATION_PERMISSIONS } from '../common/permissions/operation-permissions';
import { PERMISSIONS } from '../common/permissions/permissions';

type TerminalType = 'POP' | 'MOBILE' | 'TRACKING_SYSTEM';

const TYPE_LABEL: Readonly<Record<TerminalType, string>> = {
  POP: 'POP 단말', MOBILE: 'PDA(모바일 단말)', TRACKING_SYSTEM: '추적 시스템 연동',
};
/**
 * 화면 코드 머리가 단말 유형을 말한다 — `P-` 는 POP, `M-` 는 PDA 화면이다(권한 목록 · 화면 코드 = 권한 코드).
 * TRACKING_SYSTEM 은 사람이 쓰는 화면이 없다.
 */
const SCREEN_PREFIX: Readonly<Partial<Record<TerminalType, string>>> = { POP: 'P-', MOBILE: 'M-' };
const NAME_OF = new Map(PERMISSIONS.map((permission) => [permission.code, permission.name]));
/**
 * 닫은 경로 — 맞는 단말의 화면이 없어졌으니 그 화면을 안내하지 않고 바뀐 길을 알린다. 공정 인계는 반제품 투입으로 바뀌었다(피처 016 R-7 ·
 * PDA 「WIP 공정 이동 스캔」 화면 삭제). 맞는 단말로 부르면 409 `HANDOVER_RETIRED` 다.
 */
const RETIRED: Readonly<Record<string, { message: string; screen: string }>> = {
  'POST /production/operation-handovers': { message: '공정 인계는 반제품 투입으로 바뀌었습니다', screen: 'P-02-03' },
};

function isScreenOf(type: TerminalType, code: string): boolean {
  const prefix = SCREEN_PREFIX[type];
  return prefix !== undefined && code.startsWith(prefix);
}

/**
 * 단말 토큰은 맞는데 그 유형이 이 경로를 쓸 수 없을 때 — 「로그인이 필요합니다」는 원인을 틀리게 알려 화면이 재로그인을 권한다.
 * 그 경로를 부르는 맞는 단말의 화면을 권한 표(오퍼레이션 → 화면 코드 → 이름)에서 찾아 조치로 싣는다. 상태는 401 그대로다.
 */
export function wrongTerminalType(key: string, allowed: readonly TerminalType[], actual: string): ContractException {
  const where = allowed.map((type) => TYPE_LABEL[type]).join('·');
  const screen = (OPERATION_PERMISSIONS[key] ?? []).find((code) => allowed.some((type) => isScreenOf(type, code)));
  const actualLabel = TYPE_LABEL[actual as TerminalType] ?? actual;
  const retired = RETIRED[key];
  if (retired !== undefined) {
    return new ContractException(HttpStatus.UNAUTHORIZED, [{
      scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED,
      message: `${retired.message} — ${TYPE_LABEL.POP} ${NAME_OF.get(retired.screen) ?? ''}(${retired.screen})에서 반제품 LOT 을 스캔해 투입하세요.`,
    }]);
  }
  const action = screen === undefined
    ? `${where}에서 하세요.`
    : `${TYPE_LABEL[allowed.find((type) => isScreenOf(type, screen)) as TerminalType]} ${NAME_OF.get(screen) ?? ''}(${screen})에서 하세요.`;
  return new ContractException(HttpStatus.UNAUTHORIZED, [{
    scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED,
    message: `이 기능은 ${where}에서만 쓸 수 있습니다(지금 단말: ${actualLabel}) — ${action}`,
  }]);
}
