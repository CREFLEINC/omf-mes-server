import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { InspectionController } from './inspection/inspection.controller';
import { InspectionQueryService } from './inspection/inspection-query.service';

@Module({
  imports: [PrismaModule],
  controllers: [InspectionController],
  providers: [InspectionQueryService],
})
export class MaintenanceModule {}
