import { Module } from '@nestjs/common';

import { CodeGroupController } from './code-group.controller';
import { CodeGroupService } from './code-group.service';
import { CodeValueController } from './code-value.controller';
import { CodeValueService } from './code-value.service';

@Module({
  controllers: [CodeGroupController, CodeValueController],
  providers: [CodeGroupService, CodeValueService],
  exports: [CodeGroupService, CodeValueService],
})
export class CommonCodeModule {}
