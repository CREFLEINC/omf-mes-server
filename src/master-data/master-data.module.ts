import { Module } from '@nestjs/common';

import { CodeValidatorService } from './common-code/code-validator.service';
import { CommonCodeModule } from './common-code/common-code.module';
import { ItemController } from './item/item.controller';
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
    OrganizationService,
    WarehouseService,
  ],
  exports: [OrganizationService],
})
export class MasterDataModule {}
