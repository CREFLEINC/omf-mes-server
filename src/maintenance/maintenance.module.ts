import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { BreakdownController } from './breakdown/breakdown.controller';
import { BreakdownQueryService } from './breakdown/breakdown-query.service';
import { InspectionController } from './inspection/inspection.controller';
import { InspectionQueryService } from './inspection/inspection-query.service';

@Module({
  imports: [PrismaModule],
  controllers: [InspectionController, BreakdownController],
  providers: [InspectionQueryService, BreakdownQueryService],
})
export class MaintenanceModule {}
