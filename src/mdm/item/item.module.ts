import { Module } from '@nestjs/common';

import { ItemController } from './item.controller';
import { ItemService } from './item.service';
import { ItemValidator } from './item.validator';

@Module({
  controllers: [ItemController],
  providers: [ItemService, ItemValidator],
})
export class ItemModule {}
