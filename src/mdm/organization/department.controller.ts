import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { ReferenceQuery, runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { DepartmentService } from './department.service';

/**
 * 부서 마스터. 화면은 `W-06-06`(공통코드·조직·작업자 마스터)가 소유한다.
 *
 * ⚠ 계약이 `PUT` 에 「조직(부서)은 기간계 수신본이라 읽기 전용이 확정인데(W-06-06 §5-4)
 * 이 경로는 원본 필드 넷을 그대로 담고 있어 그 확정과 어긋난다 — 잠정 노출이며 화면은
 * 부르지 않는다. 폐쇄 여부는 결정 대기다」로 적어 두었다.
 *
 * 계약에 있으므로 만든다. 다만 그 확정을 서버가 지킨다 — `source_system_code = 'ERP'`
 * 인 행은 이 경로로도 고쳐지지 않는다(409). 폐쇄가 결정되면 경로만 빼면 된다.
 */
@Controller('mdm/departments')
export class DepartmentController {
  constructor(
    private readonly departments: DepartmentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/departments')
  list(
    @Query() query: ReferenceQuery & { businessUnitId?: number },
  ): Promise<PagedResponse<unknown>> {
    return this.departments.list(query);
  }

  @Get(':departmentId')
  @Contract('GET /mdm/departments/{departmentId}')
  async get(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { department, editability, versionNo } = await this.departments.get(departmentId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    // ⛔ 상세만 래퍼다(`DepartmentDetailResponse`). 수정·전이는 본체를 낸다.
    return { department, editability };
  }

  @Post()
  @Contract('POST /mdm/departments')
  create(@Req() request: Request, @Body() body: DepartmentWrite): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.departments.create(body),
    );
  }

  @Put(':departmentId')
  @Contract('PUT /mdm/departments/{departmentId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Body() body: DepartmentWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'department', (version) =>
      this.departments.update(departmentId, version, body),
    );
  }

  @Post(':departmentId\\:activate')
  @Contract('POST /mdm/departments/{departmentId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('departmentId', ParseIntPipe) departmentId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'department', (version) =>
      this.departments.setActive(departmentId, version, true),
    );
  }

  @Post(':departmentId\\:deactivate')
  @Contract('POST /mdm/departments/{departmentId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('departmentId', ParseIntPipe) departmentId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'department', (version) =>
      this.departments.setActive(departmentId, version, false),
    );
  }
}

interface DepartmentWrite {
  departmentCode: string;
  departmentName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  parentDepartmentId?: number | null;
  businessUnitId?: number | null;
}
