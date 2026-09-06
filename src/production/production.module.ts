import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { WorkOrderQueryService } from './work-order/work-order-query.service';
import { WorkOrderController } from './work-order/work-order.controller';

/**
 * 생산 도메인 — W/O(I-6). PR ① 은 읽기뿐이라 코어 의존이 0 이다. 쓰기(PR ③~⑥)가 붙을 때
 * 채번·상태기계·멱등·LOT 코어 모듈이 여기로 들어온다.
 */
@Module({ imports: [PrismaModule], controllers: [WorkOrderController], providers: [WorkOrderQueryService] })
export class ProductionModule {}
