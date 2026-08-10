import { Module } from '@nestjs/common';

import { ItemChildService } from './item-child.service';
import { ItemChildValidator } from './item-child.validator';
import { ItemController } from './item.controller';
import { ItemService } from './item.service';
import { ItemValidator } from './item.validator';

@Module({
  controllers: [ItemController],
  providers: [ItemService, ItemValidator, ItemChildService, ItemChildValidator],
})
export class ItemModule {}
