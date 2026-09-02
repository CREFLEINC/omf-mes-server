import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { CodeController } from './code/code.controller';
import { CodeService } from './code/code.service';
import { DepartmentController } from './organization/department.controller';
import { DepartmentService } from './organization/department.service';
import { ReferenceController } from './reference/reference.controller';
import { ReferenceService } from './reference/reference.service';

@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [ReferenceController, CodeController, DepartmentController],
  providers: [ReferenceService, CodeService, DepartmentService],
})
export class MdmModule {}
