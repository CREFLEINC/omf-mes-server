import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { CodeController } from './code/code.controller';
import { CodeService } from './code/code.service';
import { DepartmentController } from './organization/department.controller';
import { DepartmentService } from './organization/department.service';
import { WorkerController } from './organization/worker.controller';
import { EquipmentGroupController } from './equipment/equipment-group.controller';
import { EquipmentGroupService } from './equipment/equipment-group.service';
import { InspectionAssignmentController } from './equipment/inspection-assignment.controller';
import { InspectionAssignmentService } from './equipment/inspection-assignment.service';
import { InspectionItemController } from './equipment/inspection-item.controller';
import { InspectionItemService } from './equipment/inspection-item.service';
import { ItemDetailController } from './item/item-detail.controller';
import { ItemDetailService } from './item/item-detail.service';
import { ItemController } from './item/item.controller';
import { ItemService } from './item/item.service';
import { LocationController } from './logistics/location.controller';
import { LocationService } from './logistics/location.service';
import { WarehouseLayoutController } from './logistics/warehouse-layout.controller';
import { WarehouseLayoutService } from './logistics/warehouse-layout.service';
import { WarehouseController } from './logistics/warehouse.controller';
import { WarehouseService } from './logistics/warehouse.service';
import { WorkerService } from './organization/worker.service';
import { ReferenceController } from './reference/reference.controller';
import { ReferenceService } from './reference/reference.service';

@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [ReferenceController, CodeController, DepartmentController, WorkerController, WarehouseController, WarehouseLayoutController, LocationController, ItemController, ItemDetailController, InspectionItemController, EquipmentGroupController, InspectionAssignmentController],
  providers: [ReferenceService, CodeService, DepartmentService, WorkerService, WarehouseService, WarehouseLayoutService, LocationService, ItemService, ItemDetailService, InspectionItemService, EquipmentGroupService, InspectionAssignmentService],
})
export class MdmModule {}
