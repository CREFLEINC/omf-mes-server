import { SetMetadata } from '@nestjs/common';

/**
 * 단말 등록 확인(FR-007) — MOBILE·POP 토큰의 현재 세대만 연다. 세션 쿠키는 401 이다.
 * 계약 키(`@Contract`)와 따로 두는 이유: 일반 경로는 세션을 먼저 받는데 이 자리는 세션을 받지 않는다.
 */
export const TERMINAL_REGISTRATION_OPERATION = 'terminal:confirm-registration';
export const TerminalRegistrationOperation = (): MethodDecorator =>
  SetMetadata(TERMINAL_REGISTRATION_OPERATION, true);

/** POP [화면 이동] 후보 — POP 토큰의 현재 세대가 «자기» 단말만 읽는다. 세션 쿠키는 401 이다. */
export const TERMINAL_ACCESSIBLE_SCREENS_OPERATION = 'terminal:accessible-screens';
export const TerminalAccessibleScreensOperation = (): MethodDecorator =>
  SetMetadata(TERMINAL_ACCESSIBLE_SCREENS_OPERATION, true);
