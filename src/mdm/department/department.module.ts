import { Module } from '@nestjs/common';

import { DepartmentController } from './department.controller';
import { DepartmentService } from './department.service';
import { DepartmentValidator } from './department.validator';

@Module({
  controllers: [DepartmentController],
  providers: [DepartmentService, DepartmentValidator],
})
export class DepartmentModule {}
