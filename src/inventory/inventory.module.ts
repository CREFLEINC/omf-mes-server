import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryAdjustmentController } from './adjustment/inventory-adjustment.controller';
import { InventoryAdjustmentQueryService } from './adjustment/inventory-adjustment-query.service';
import { InventoryAdjustmentUpdateService } from './adjustment/inventory-adjustment-update.service';
import { InventoryAdjustmentService } from './adjustment/inventory-adjustment.service';
import { InventoryBalanceController } from './balance/inventory-balance.controller';
import { InventoryBalanceService } from './balance/inventory-balance.service';
import { InventoryReservationController } from './balance/inventory-reservation.controller';
import { InventoryReservationService } from './balance/inventory-reservation.service';
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
  // ⛔ 코어는 «쓰는 것만» 배선한다 — 원장·승인은 `:post`·상신 PR 이 그때 더한다.
  imports: [PrismaModule, IdempotencyModule, NumberingModule, ApprovalModule],
  controllers: [
    InventoryTransactionController,
    InventoryBalanceController,
    InventoryReservationController,
    InventoryAdjustmentController,
  ],
  providers: [
    InventoryTransactionService,
    InventoryBalanceService,
    InventoryReservationService,
    InventoryAdjustmentQueryService,
    InventoryAdjustmentService,
    InventoryAdjustmentUpdateService,
  ],
})
export class InventoryModule {}
