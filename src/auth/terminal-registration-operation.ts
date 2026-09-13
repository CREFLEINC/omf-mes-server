import { SetMetadata } from '@nestjs/common';

/** Forward-only FR-007 operation absent from the read-only design contract copy. */
export const TERMINAL_REGISTRATION_OPERATION = 'terminal:confirm-registration';
export const TerminalRegistrationOperation = (): MethodDecorator =>
  SetMetadata(TERMINAL_REGISTRATION_OPERATION, true);
