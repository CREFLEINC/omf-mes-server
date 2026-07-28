import { Module } from '@nestjs/common';

import {
  BomComponentController,
  BomController,
} from './bom/bom.controller';
import { BomService } from './bom/bom.service';
import {
  ApprovalRouteController,
} from './approval-route/approval-route.controller';
import { ApprovalRouteService } from './approval-route/approval-route.service';
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
import { NumberingRuleController } from './numbering/numbering-rule.controller';
import { NumberingRuleService } from './numbering/numbering-rule.service';
import { NumberingService } from './numbering/numbering.service';
import { OperationPolicyController } from './operation-policy/operation-policy.controller';
import { OperationPolicyService } from './operation-policy/operation-policy.service';
import { PartnerService } from './partner/partner.service';
import { PutawayRuleController } from './putaway-rule/putaway-rule.controller';
import { PutawayRuleService } from './putaway-rule/putaway-rule.service';
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
    OperationPolicyController,
    NumberingRuleController,
    ApprovalRouteController,
    PutawayRuleController,
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
    OperationPolicyService,
    NumberingRuleService,
    NumberingService,
    ApprovalRouteService,
    PutawayRuleService,
  ],
  exports: [
    OrganizationService,
    DepartmentService,
    CodeValidatorService,
    // POP이 작업 시작 시 자격 강제 수준을 묻고, 실적 등록 시 번호를 받아 간다.
    OperationPolicyService,
    NumberingService,
  ],
})
export class MasterDataModule {}
