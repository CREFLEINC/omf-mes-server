import { Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import type { components } from '../../contracts/mdm';
import { ReplaceQualificationsDto } from './worker-qualification.dto';
import { WorkerQueryDto } from './worker.query.dto';
import { WorkerService } from './worker.service';

/**
 * 작업자 기본 정보는 **테이블 전체가 ERP 수신본**이라 쓰기 경로가 없다 — 목록·상세뿐이다.
 * MES 가 덧붙이는 것은 자격·인증이고, 그것만 전체 치환으로 편집한다.
 */
@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/workers')
export class WorkerController {
  constructor(private readonly service: WorkerService) {}

  @Get()
  @ApiOperation({ summary: '작업자 목록 — 읽기 전용' })
  findAll(@Query() query: WorkerQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':workerId/qualifications')
  @ApiOperation({ summary: '작업자 자격·인증 목록' })
  findQualifications(
    @Param('workerId', ParseIntPipe) workerId: number,
  ): Promise<components['schemas']['WorkerQualificationListResponse']> {
    return this.service.findQualifications(BigInt(workerId));
  }

  /**
   * 최종 상태를 통째로 받는다 — 안 보낸 행은 지워진다(공유계약 B-6).
   * `If-Match` 를 받지 않는다: 이 테이블에는 `version_no` 가 없다.
   */
  @RequirePermissions('MASTER_ORGANIZATION_WRITE')
  @Put(':workerId/qualifications')
  @ApiOperation({ summary: '자격·인증 전체 치환' })
  @ApiResponse({ status: 400, description: '검증 실패 — 목록 안 중복 포함' })
  replaceQualifications(
    @Param('workerId', ParseIntPipe) workerId: number,
    @Body() dto: ReplaceQualificationsDto,
    @ActorId() actorId: bigint,
  ): Promise<components['schemas']['WorkerQualificationListResponse']> {
    return this.service.replaceQualifications(BigInt(workerId), dto.qualifications, actorId);
  }

  @Get(':workerId')
  @ApiOperation({ summary: '작업자 상세 — 읽기 전용' })
  @ApiResponse({ status: 404, description: '없는 작업자' })
  findOne(
    @Param('workerId', ParseIntPipe) workerId: number,
  ): Promise<components['schemas']['WorkerDetailResponse']> {
    return this.service.findOne(BigInt(workerId));
  }
}
