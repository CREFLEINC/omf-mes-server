import { Module } from '@nestjs/common';

import { InventoryPostingService } from './inventory-posting.service';

@Module({
  providers: [InventoryPostingService],
  exports: [InventoryPostingService],
})
export class InventoryPostingModule {}
