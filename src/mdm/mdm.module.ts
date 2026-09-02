import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { CodeController } from './code/code.controller';
import { CodeService } from './code/code.service';
import { DepartmentController } from './organization/department.controller';
import { DepartmentService } from './organization/department.service';
import { WorkerController } from './organization/worker.controller';
import { LocationController } from './logistics/location.controller';
import { LocationService } from './logistics/location.service';
import { WarehouseController } from './logistics/warehouse.controller';
import { WarehouseService } from './logistics/warehouse.service';
import { WorkerService } from './organization/worker.service';
import { ReferenceController } from './reference/reference.controller';
import { ReferenceService } from './reference/reference.service';

@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [ReferenceController, CodeController, DepartmentController, WorkerController, WarehouseController, LocationController],
  providers: [ReferenceService, CodeService, DepartmentService, WorkerService, WarehouseService, LocationService],
})
export class MdmModule {}
