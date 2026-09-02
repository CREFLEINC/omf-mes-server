import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { DocumentStateModule } from '../core/document-state';
import { PrismaModule } from '../prisma/prisma.module';
import { CodeController } from './code/code.controller';
import { CodeService } from './code/code.service';
import { DepartmentController } from './organization/department.controller';
import { DepartmentService } from './organization/department.service';
import { WorkerController } from './organization/worker.controller';
import { AuthModule } from '../auth/auth.module';
import { EquipmentController } from './equipment/equipment.controller';
import { EquipmentService } from './equipment/equipment.service';
import { EquipmentGroupController } from './equipment/equipment-group.controller';
import { EquipmentGroupService } from './equipment/equipment-group.service';
import { InspectionAssignmentController } from './equipment/inspection-assignment.controller';
import { InspectionAssignmentService } from './equipment/inspection-assignment.service';
import { InspectionItemController } from './equipment/inspection-item.controller';
import { InspectionItemService } from './equipment/inspection-item.service';
import { JudgmentTypeControlController, PartnerController } from './partner/partner.controller';
import { JudgmentTypeControlService } from './partner/judgment-type-control.service';
import { PartnerService } from './partner/partner.service';
import { SparePartController } from './spare-part/spare-part.controller';
import {
  WorkCalendarApplicationController,
  WorkCalendarController,
} from './work-calendar/work-calendar.controller';
import { WorkCalendarService } from './work-calendar/work-calendar.service';
import { SparePartService } from './spare-part/spare-part.service';
import { TerminalController } from './terminal/terminal.controller';
import { TerminalService } from './terminal/terminal.service';
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
  // AuthModule 이 JwtModule 을 내보낸다 — 단말 등록 토큰이 세션과 같은 비밀키로 서명된다.
  imports: [PrismaModule, IdempotencyModule, DocumentStateModule, AuthModule],
  controllers: [ReferenceController, CodeController, DepartmentController, WorkerController, WarehouseController, WarehouseLayoutController, LocationController, ItemController, ItemDetailController, InspectionItemController, EquipmentGroupController, InspectionAssignmentController, EquipmentController, TerminalController, SparePartController, PartnerController, JudgmentTypeControlController, WorkCalendarController, WorkCalendarApplicationController],
  providers: [ReferenceService, CodeService, DepartmentService, WorkerService, WarehouseService, WarehouseLayoutService, LocationService, ItemService, ItemDetailService, InspectionItemService, EquipmentGroupService, InspectionAssignmentService, EquipmentService, TerminalService, SparePartService, PartnerService, JudgmentTypeControlService, WorkCalendarService],
})
export class MdmModule {}
