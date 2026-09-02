import { Body, Controller, Get, Param, ParseIntPipe, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { ReferenceQuery, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { WorkerService } from './worker.service';

/**
 * 작업자 마스터. 기본 정보는 **쓰기 경로가 없다** — 전부 ERP 수신본이다(W-06-06 §5-4).
 * MES 가 고치는 것은 둘뿐이다: 다국어 명칭(QA #33·#34)과 자격·인증(MES 확장).
 */
@Controller('mdm/workers')
export class WorkerController {
  constructor(
    private readonly workers: WorkerService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/workers')
  list(@Query() query: WorkerQuery): Promise<PagedResponse<unknown>> {
    return this.workers.list(query);
  }

  @Get(':workerId')
  @Contract('GET /mdm/workers/{workerId}')
  async get(
    @Param('workerId', ParseIntPipe) workerId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { worker, editability, versionNo } = await this.workers.get(workerId);
    // ⚠ 계약은 이 자리에 ETag 를 선언하지 않았다. 그런데 :update-name-translation 은
    // If-Match 를 «필수»로 요구한다 — 화면이 값을 얻을 자리가 계약 안에 없다.
    // 붙여서 낸다. 헤더가 하나 더 오는 것은 계약 위반이 아니고, 없으면 그 쓰기를
    // 부를 수 없다. 되돌림 문서에 적었다.
    setEtag(response, versionNo);
    return { worker, editability };
  }

  @Put(':workerId\\:update-name-translation')
  @Contract('PUT /mdm/workers/{workerId}:update-name-translation')
  updateNameTranslation(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('workerId', ParseIntPipe) workerId: number,
    @Body() body: { nameKo?: string | null; nameVi?: string | null },
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'worker', (version) =>
      this.workers.updateNameTranslation(workerId, version, body),
    );
  }

  @Get(':workerId/qualifications')
  @Contract('GET /mdm/workers/{workerId}/qualifications')
  async listQualifications(
    @Param('workerId', ParseIntPipe) workerId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { items, versionNo } = await this.workers.listQualifications(workerId);
    setEtag(response, versionNo);
    return { items };
  }

  @Put(':workerId/qualifications')
  @Contract('PUT /mdm/workers/{workerId}/qualifications')
  async replaceQualifications(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('workerId', ParseIntPipe) workerId: number,
    @Body() body: { qualifications: QualificationInput[] },
  ): Promise<unknown> {
    const items = await runVersioned(this.idempotency, request, response, 'items', (version) =>
      this.workers.replaceQualifications(
        workerId,
        version,
        body.qualifications,
        currentSession(request)?.userId,
      ),
    );
    return { items };
  }
}

interface WorkerQuery extends ReferenceQuery {
  workerNo?: string;
  departmentId?: number;
  plantId?: number;
  businessUnitId?: number;
}

interface QualificationInput {
  qualificationTypeCode: string;
  processId?: number | null;
  certificateNo?: string | null;
  validFrom: string;
  validTo?: string | null;
  certifiedBy?: number | null;
}
