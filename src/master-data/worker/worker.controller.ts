import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PageQueryDto } from '../../common/dto/page-query.dto';
import { DepartmentService } from './department.service';
import {
  CreateDepartmentDto,
  CreateQualificationDto,
  CreateWorkerDto,
  QualificationQueryDto,
  UpdateDepartmentDto,
  UpdateWorkerDto,
  WorkerQueryDto,
} from './worker.dto';
import { WorkerService } from './worker.service';

@ApiTags('기준정보 — 부서')
@Controller('master/departments')
export class DepartmentController {
  constructor(private readonly service: DepartmentService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '부서 등록' })
  @ApiResponse({ status: 400, description: '상위 부서 순환' })
  @ApiResponse({ status: 409, description: '부서 코드 중복' })
  create(@Body() dto: CreateDepartmentDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '부서 목록' })
  findAll(@Query() query: PageQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':departmentCode')
  @ApiOperation({ summary: '부서 단건 조회' })
  @ApiParam({ name: 'departmentCode', example: 'DEPT_PROD' })
  findOne(@Param('departmentCode') departmentCode: string) {
    return this.service.findOne(departmentCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':departmentCode')
  @ApiOperation({ summary: '부서 수정' })
  update(@Param('departmentCode') departmentCode: string, @Body() dto: UpdateDepartmentDto, @ActorId() actor?: bigint) {
    return this.service.update(departmentCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':departmentCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '부서 비활성화' })
  @ApiResponse({ status: 409, description: '하위 부서·작업자가 참조 중' })
  deactivate(@Param('departmentCode') departmentCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(departmentCode, actor);
  }
}

@ApiTags('기준정보 — 작업자')
@Controller('master/workers')
export class WorkerController {
  constructor(private readonly service: WorkerService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '작업자 등록' })
  @ApiResponse({ status: 400, description: '재직 상태 코드값 오류' })
  @ApiResponse({ status: 409, description: '사번 중복' })
  create(@Body() dto: CreateWorkerDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '작업자 목록 — 공장·부서·재직상태로 좁힐 수 있다' })
  findAll(@Query() query: WorkerQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':workerNo')
  @ApiOperation({ summary: '작업자 단건 조회 (부서·보유 자격 포함)' })
  @ApiParam({ name: 'workerNo', example: 'W0001' })
  findOne(@Param('workerNo') workerNo: string) {
    return this.service.findOne(workerNo);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':workerNo')
  @ApiOperation({ summary: '작업자 수정' })
  update(@Param('workerNo') workerNo: string, @Body() dto: UpdateWorkerDto, @ActorId() actor?: bigint) {
    return this.service.update(workerNo, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':workerNo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '작업자 비활성화 (퇴직 처리 등)' })
  deactivate(@Param('workerNo') workerNo: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(workerNo, actor);
  }

  // ── 자격 ──────────────────────────────────────────────────────────────

  @RequirePermissions('MASTER_WRITE')
  @Post(':workerNo/qualifications')
  @ApiOperation({ summary: '자격 부여 — 공정 수행·검사자 자격' })
  @ApiResponse({ status: 400, description: '자격 유형 코드값 오류 · 유효기간 역전' })
  @ApiResponse({ status: 409, description: '동일 (유형·공정·시작일) 중복' })
  addQualification(@Param('workerNo') workerNo: string, @Body() dto: CreateQualificationDto, @ActorId() actor?: bigint) {
    return this.service.addQualification(workerNo, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':workerNo/qualifications')
  @ApiOperation({ summary: '자격 목록 — validOn으로 기준일 유효분만 조회' })
  findQualifications(@Param('workerNo') workerNo: string, @Query() query: QualificationQueryDto) {
    return this.service.findQualifications(workerNo, query);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':workerNo/qualifications/:qualificationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '자격 삭제 (이력 테이블이라 물리 삭제)' })
  removeQualification(
    @Param('workerNo') workerNo: string,
    @Param('qualificationId', ParseIntPipe) qualificationId: number
  ) {
    return this.service.removeQualification(workerNo, BigInt(qualificationId));
  }
}
