import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { NumberingService } from './numbering.service';

/** ⛔ 다른 코어와 달리 Prisma 를 받는다 — 카운터는 업무 트랜잭션 밖에서 오른다(I-2.md R-2). */
@Module({
  imports: [PrismaModule],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
