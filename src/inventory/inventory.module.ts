import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { InventoryBalanceController } from './balance/inventory-balance.controller';
import { InventoryBalanceService } from './balance/inventory-balance.service';
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
  imports: [PrismaModule],
  controllers: [InventoryTransactionController, InventoryBalanceController],
  providers: [InventoryTransactionService, InventoryBalanceService],
})
export class InventoryModule {}
