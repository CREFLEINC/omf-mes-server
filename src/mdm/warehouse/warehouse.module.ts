import { Module } from '@nestjs/common';

import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';
import { WarehouseValidator } from './warehouse.validator';

@Module({
  controllers: [WarehouseController],
  providers: [WarehouseService, WarehouseValidator],
})
export class WarehouseModule {}
