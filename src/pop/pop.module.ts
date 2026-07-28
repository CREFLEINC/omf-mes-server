import { Module } from '@nestjs/common';

import { PopController } from './pop.controller';

/** TerminalAuthService는 AuthModule(@Global)이 export한다. */
@Module({ controllers: [PopController] })
export class PopModule {}
