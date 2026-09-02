import { Module } from '@nestjs/common';

import { CredentialService } from './credential.service';
import { SessionService } from './session.service';

@Module({
  providers: [CredentialService, SessionService],
  exports: [CredentialService, SessionService],
})
export class AuthModule {}
