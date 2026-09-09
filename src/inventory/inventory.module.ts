import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { DocumentStateModule } from '../core/document-state';
import { InventoryPostingModule } from '../core/inventory-posting';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryAdjustmentController } from './adjustment/inventory-adjustment.controller';
import { InventoryAdjustmentQueryService } from './adjustment/inventory-adjustment-query.service';
import { InventoryAdjustmentUpdateService } from './adjustment/inventory-adjustment-update.service';
import { InventoryAdjustmentService } from './adjustment/inventory-adjustment.service';
import { InventoryBalanceController } from './balance/inventory-balance.controller';
import { InventoryBalanceService } from './balance/inventory-balance.service';
import { InventoryCountController } from './count/inventory-count.controller';
import { InventoryCountCloseService } from './count/inventory-count-close.service';
import { InventoryCountCreateService } from './count/inventory-count-create.service';
import { InventoryCountQueryService } from './count/inventory-count-query.service';
import { InventoryCountUpdateService } from './count/inventory-count-update.service';
import { InventoryReservationController } from './balance/inventory-reservation.controller';
import { InventoryReservationService } from './balance/inventory-reservation.service';
import { HandlingUnitContentService } from './handling-unit/handling-unit-content.service';
import { HandlingUnitController } from './handling-unit/handling-unit.controller';
import { HandlingUnitPackService } from './handling-unit/handling-unit-pack.service';
import { HandlingUnitQueryService } from './handling-unit/handling-unit-query.service';
import { HandlingUnitService } from './handling-unit/handling-unit.service';
import { RepackEventService } from './handling-unit/repack-event.service';
import { InventoryTransactionController } from './transaction/inventory-transaction.controller';
import { InventoryTransactionService } from './transaction/inventory-transaction.service';

/**
 * 계약 최상위 경로 `/inventory` — 원장 조회·실사·조정·취급단위.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 *
 * ⚠ 원장을 «쓰는» 것은 이 모듈이 아니라 `src/core/inventory-posting` 이다. 여기는
 * 그것이 남긴 것을 읽기만 한다.
 */
@Module({
  // ⛔ 코어는 «쓰는 것만» 배선한다 — 원장·상태기계는 `:post`(I-14 PR ④)가 데려왔다.
  imports: [
    PrismaModule,
    IdempotencyModule,
    NumberingModule,
    ApprovalModule,
    InventoryPostingModule,
    DocumentStateModule,
  ],
  controllers: [
    InventoryTransactionController,
    InventoryBalanceController,
    InventoryReservationController,
    InventoryAdjustmentController,
    InventoryCountController,
    HandlingUnitController,
  ],
  providers: [
    InventoryTransactionService,
    InventoryBalanceService,
    InventoryReservationService,
    InventoryAdjustmentQueryService,
    InventoryAdjustmentService,
    InventoryAdjustmentUpdateService,
    InventoryCountQueryService,
    InventoryCountCloseService,
    InventoryCountCreateService,
    InventoryCountUpdateService,
    HandlingUnitQueryService,
    RepackEventService,
    HandlingUnitService,
    HandlingUnitContentService,
    HandlingUnitPackService,
  ],
})
export class InventoryModule {}
