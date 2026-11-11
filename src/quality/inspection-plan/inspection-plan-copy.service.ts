import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanVersionService } from './inspection-plan-version.service';
import { InspectionPlanService, InspectionPlanWrite } from './inspection-plan.service';

export interface InspectionPlanCopy extends InspectionPlanWrite {
  /** 내용(버전 설정 · 검사 항목)을 가져올 원본 기준의 버전 */
  sourceVersionId: number;
}

export interface InspectionPlanCopyResult {
  inspectionPlanId: number;
  inspectionPlanVersionId: number;
}

/**
 * 검사기준 복사(omf-all-around#255) — 원본 버전의 설정 · 검사 항목을 새 기준의 작성중 버전 1 로 만든다.
 * 도면은 품목마다 달라 가져오지 않는다(사용자 결정 2026-11-11).
 *
 * ⭐ 엑셀 올리기(`inspection-plan-import.service.ts`)처럼 화면이 부르는 기능을 같은 순서로 불러 검증 · 문구가 같다.
 * ⛔ 중간에 실패하면 이 복사가 만든 버전 · 기준을 지운다 — 반쯤 선 기준이 남지 않게.
 */
@Injectable()
export class InspectionPlanCopyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: InspectionPlanService,
    private readonly versions: InspectionPlanVersionService,
  ) {}

  async copy(sourcePlanId: number, input: InspectionPlanCopy, actorId: number): Promise<InspectionPlanCopyResult> {
    const { sourceVersionId, ...plan } = input;
    const { inspectionPlanVersion: source } = await this.versions.get(sourceVersionId);
    if (source.inspectionPlanId !== sourcePlanId) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'field', field: 'sourceVersionId', code: ERROR_CODE.INVALID, message: '이 기준의 버전이 아닙니다.' },
      ]);
    }
    const items = await this.versions.listItems(sourceVersionId);

    const created = await this.plans.create(plan);
    const planId = created.inspectionPlanId;
    let versionId: number | null = null;
    try {
      const version = await this.versions.create(
        {
          inspectionPlanId: planId,
          effectiveFrom: source.effectiveFrom,
          effectiveTo: source.effectiveTo,
          samplingMethodCode: source.samplingMethodCode,
          samplingRatio: source.samplingRatio,
          samplingQty: source.samplingQty,
          aqlValue: source.aqlValue,
          acceptanceNumber: source.acceptanceNumber,
          rejectionNumber: source.rejectionNumber,
          inspectionFrequencyCode: source.inspectionFrequencyCode,
          frequencyIntervalValue: source.frequencyIntervalValue,
          frequencyIntervalUomCode: source.frequencyIntervalUomCode,
          guideText: source.guideText,
        },
        { allowMissingRatio: true },
        actorId,
      );
      versionId = version.inspectionPlanVersionId;
      await this.versions.replaceItems(
        versionId,
        items.map(({ inspectionItemSpecId: _id, ...item }) => ({ ...item, inspectionPlanVersionId: versionId as number })),
        actorId,
        { allowNumericWithoutUom: true },
      );
      return { inspectionPlanId: planId, inspectionPlanVersionId: versionId };
    } catch (error) {
      if (versionId !== null) await this.versions.discard(versionId, actorId);
      // 방금 만든 기준이라 가리키는 것이 없다.
      await this.prisma.inspection_plan.delete({ where: { inspection_plan_id: planId } });
      throw error;
    }
  }
}
