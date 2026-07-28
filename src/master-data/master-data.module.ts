import { Module } from '@nestjs/common';

import {
  BomComponentController,
  BomController,
} from './bom/bom.controller';
import { BomService } from './bom/bom.service';
import { CodeValidatorService } from './common-code/code-validator.service';
import { CommonCodeModule } from './common-code/common-code.module';
import {
  EquipmentController,
  ProductionLineController,
} from './equipment/equipment.controller';
import {
  InspectionItemSpecController,
  InspectionPlanController,
  InspectionPlanVersionController,
} from './inspection/inspection-plan.controller';
import { InspectionPlanService } from './inspection/inspection-plan.service';
import { EquipmentService } from './equipment/equipment.service';
import { ProductionLineService } from './equipment/production-line.service';
import { ItemController } from './item/item.controller';
import { MoldController } from './mold/mold.controller';
import { MoldService } from './mold/mold.service';
import { ItemService } from './item/item.service';
import {
  BusinessUnitController,
  LegalEntityController,
  PlantController,
} from './organization/organization.controller';
import { OrganizationService } from './organization/organization.service';
import { PartnerController } from './partner/partner.controller';
import { ProcessController } from './process/process.controller';
import { ProcessService } from './process/process.service';
import { PartnerService } from './partner/partner.service';
import { CauseCodeService } from './quality-code/cause-code.service';
import { DefectCodeService } from './quality-code/defect-code.service';
import {
  CauseCodeController,
  DefectCodeController,
} from './quality-code/quality-code.controller';
import {
  RoutingController,
  RoutingOperationController,
} from './routing/routing.controller';
import { RoutingService } from './routing/routing.service';
import { ShiftService } from './terminal/shift.service';
import {
  ShiftController,
  TerminalController,
} from './terminal/terminal.controller';
import { TerminalService } from './terminal/terminal.service';
import { DepartmentService } from './worker/department.service';
import {
  DepartmentController,
  WorkerController,
} from './worker/worker.controller';
import { WorkerService } from './worker/worker.service';
import { UomController } from './uom/uom.controller';
import { UomService } from './uom/uom.service';
import {
  LocationController,
  WarehouseController,
} from './warehouse/warehouse.controller';
import { WarehouseService } from './warehouse/warehouse.service';

@Module({
  imports: [CommonCodeModule],
  controllers: [
    UomController,
    ItemController,
    PartnerController,
    ProcessController,
    ProductionLineController,
    EquipmentController,
    MoldController,
    DepartmentController,
    WorkerController,
    ShiftController,
    TerminalController,
    LegalEntityController,
    BusinessUnitController,
    PlantController,
    WarehouseController,
    LocationController,
    RoutingController,
    RoutingOperationController,
    BomController,
    BomComponentController,
    InspectionPlanController,
    InspectionPlanVersionController,
    InspectionItemSpecController,
    DefectCodeController,
    CauseCodeController,
  ],
  providers: [
    CodeValidatorService,
    UomService,
    ItemService,
    PartnerService,
    ProcessService,
    ProductionLineService,
    EquipmentService,
    MoldService,
    DepartmentService,
    WorkerService,
    ShiftService,
    TerminalService,
    OrganizationService,
    WarehouseService,
    RoutingService,
    BomService,
    InspectionPlanService,
    DefectCodeService,
    CauseCodeService,
  ],
  exports: [OrganizationService, DepartmentService, CodeValidatorService],
})
export class MasterDataModule {}
