import { Module } from '@nestjs/common';

import { LookupController } from './lookup.controller';
import { LookupService } from './lookup.service';

@Module({
  controllers: [LookupController],
  providers: [LookupService],
})
export class LookupModule {}
