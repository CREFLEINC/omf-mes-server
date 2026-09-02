import { Body, Controller, Get, Param, ParseIntPipe, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { AssignmentInput, InspectionAssignmentService } from './inspection-assignment.service';

/**
 * 점검항목 부여. 설비와 그룹 두 층이 같은 모양이라 한 컨트롤러에 둔다 —
 * 경로가 갈릴 뿐 저장 단위(통째 교체)와 잠금 축(부모의 version_no)이 같다.
 */
@Controller('mdm')
export class InspectionAssignmentController {
  constructor(
    private readonly assignments: InspectionAssignmentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('equipment-groups/:equipmentGroupId/inspection-items')
  @Contract('GET /mdm/equipment-groups/{equipmentGroupId}/inspection-items')
  async listGroup(
    @Param('equipmentGroupId', ParseIntPipe) equipmentGroupId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { items, versionNo } = await this.assignments.listGroupAssignments(equipmentGroupId);
    setEtag(response, versionNo);
    return { items };
  }

  @Put('equipment-groups/:equipmentGroupId/inspection-items')
  @Contract('PUT /mdm/equipment-groups/{equipmentGroupId}/inspection-items')
  async replaceGroup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentGroupId', ParseIntPipe) equipmentGroupId: number,
    @Body() body: { items: AssignmentInput[] },
  ): Promise<unknown> {
    const items = await runVersioned(this.idempotency, request, response, 'items', (version) =>
      this.assignments.replaceGroupAssignments(
        equipmentGroupId,
        version,
        body.items,
        currentSession(request)?.userId,
      ),
    );
    return { items };
  }

  @Get('equipments/:equipmentId/inspection-items')
  @Contract('GET /mdm/equipments/{equipmentId}/inspection-items')
  async listEquipment(
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.assignments.listEquipmentAssignments(equipmentId);
    setEtag(response, result.versionNo);
    return body(result);
  }

  @Put('equipments/:equipmentId/inspection-items')
  @Contract('PUT /mdm/equipments/{equipmentId}/inspection-items')
  replaceEquipment(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
    @Body() input: { items: AssignmentInput[] },
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'resolved', async (version) => {
      const result = await this.assignments.replaceEquipmentAssignments(
        equipmentId,
        version,
        input.items,
        currentSession(request)?.userId,
      );
      return { resolved: body(result), versionNo: result.versionNo };
    });
  }
}

/** 계약 응답에는 `versionNo` 가 없다 — ETag 로만 나간다(공유계약 A-4). */
function body(result: {
  assigned: unknown[];
  effective: unknown[];
  resolvedFromLevelCode: string;
  resolvedFromGroupId: number | null;
}): unknown {
  return {
    assigned: result.assigned,
    effective: result.effective,
    resolvedFromLevelCode: result.resolvedFromLevelCode,
    resolvedFromGroupId: result.resolvedFromGroupId,
  };
}
