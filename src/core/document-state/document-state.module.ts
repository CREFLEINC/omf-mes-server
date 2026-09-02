import { Module } from '@nestjs/common';

import { DocumentStateService } from './document-state.service';

@Module({
  providers: [DocumentStateService],
  exports: [DocumentStateService],
})
export class DocumentStateModule {}
