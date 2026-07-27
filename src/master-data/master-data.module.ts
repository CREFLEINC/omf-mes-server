import { Module } from '@nestjs/common';

import { CodeValidatorService } from './common-code/code-validator.service';
import { CommonCodeModule } from './common-code/common-code.module';
import {
  EquipmentController,
  ProductionLineController,
} from './equipment/equipment.controller';
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

/** 기준정보(마스터) 도메인 — 정본 물리 모델의 mdm 스키마 */
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
  ],
  exports: [OrganizationService, DepartmentService, CodeValidatorService],
})
export class MasterDataModule {}
