import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { ProductLotSplitQueryService } from './product-lot-split-query.service';
import { ProductLotSplitController } from './product-lot-split.controller';

/** 생산 LOT 수량 분리(피처 013). */
@Module({
  imports: [PrismaModule],
  controllers: [ProductLotSplitController],
  providers: [ProductLotSplitQueryService],
})
export class ProductLotSplitModule {}
