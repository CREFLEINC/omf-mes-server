import { SetMetadata } from '@nestjs/common';

/** Forward-only FR-007 operation absent from the read-only design contract copy. */
export const TERMINAL_REGISTRATION_OPERATION = 'terminal:confirm-registration';
export const TerminalRegistrationOperation = (): MethodDecorator =>
  SetMetadata(TERMINAL_REGISTRATION_OPERATION, true);

/** Forward-only POP navigation read for the authenticated device itself. */
export const TERMINAL_ACCESSIBLE_SCREENS_OPERATION = 'terminal:accessible-screens';
export const TerminalAccessibleScreensOperation = (): MethodDecorator =>
  SetMetadata(TERMINAL_ACCESSIBLE_SCREENS_OPERATION, true);
