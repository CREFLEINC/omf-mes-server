import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { REVISION_STATUS } from '../../planning/revision-status';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportRow, parseInspectionPlanWorkbook } from './inspection-plan-import';
import { ImportGroup, checkGroup, fail, groupRows } from './inspection-plan-import-check';
import { InspectionPlanVersionService, ItemSpecUpsert, VersionWrite } from './inspection-plan-version.service';
import { InspectionPlanService } from './inspection-plan.service';

/** 계약 `BatchResult` — 전체 롤백하지 않고 거부 건만 되돌린다(공유계약 C-2). 반영 단위는 기준코드다. */
export interface BatchResult {
  succeeded: number;
  failed: { index: number; key?: string; errors: ErrorItem[] }[];
}

/**
 * 검사기준 엑셀 올리기(omf-all-around#199 · 장부 P-140).
 *
 * ⭐ **새 규칙을 두지 않는다** — 화면이 부르는 기능을 같은 순서로 부른다. 그래서 검증·문구가 화면과 같다.
 *   - 새 기준코드: 기준 등록 → 버전 등록 → 항목 저장
 *   - 있는 기준코드: 신규 버전 발행 → 버전 설정 저장 → 항목 저장(확정 버전이 없으면 발행이 거절한다)
 * ⛔ 한 묶음이 중간에 실패하면 그 묶음에서 만든 것만 되돌린다 — 반쯤 선 기준·버전이 남으면 다음 올리기가
 *    「이미 있는 기준」으로 갈라져 같은 파일을 다시 올려도 결과가 달라진다.
 */
@Injectable()
export class InspectionPlanImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: InspectionPlanService,
    private readonly versions: InspectionPlanVersionService,
  ) {}

  async importWorkbook(buffer: Buffer): Promise<BatchResult> {
    const parsed = await parseInspectionPlanWorkbook(buffer);
    if (parsed.error) throw new ContractException(HttpStatus.BAD_REQUEST, [parsed.error]);

    const result: BatchResult = { succeeded: 0, failed: [] };
    // ⛔ 묶음씩 차례로 넣는다 — 같은 기준코드·품목을 두 묶음이 동시에 만들면 유일 검사를 둘 다 통과한다.
    for (const group of groupRows(parsed.rows)) {
      const checked = checkGroup(group);
      if (checked.length > 0) {
        result.failed.push({ index: group.index, key: group.key, errors: checked });
        continue;
      }
      try {
        await this.apply(group);
        result.succeeded += 1;
      } catch (error) {
        if (!(error instanceof ContractException)) throw error;
        result.failed.push({ index: group.index, key: group.key, errors: error.errors });
      }
    }
    return result;
  }

  private async apply(group: ImportGroup): Promise<void> {
    const [first] = group.rows;
    const items = await this.items(group.rows);
    const existing = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_code: group.key },
      select: { inspection_plan_id: true, inspection_type_code: true, item_id: true },
    });

    if (existing === null) {
      const plan = await this.createPlan(first);
      try {
        await this.createVersion(plan, first, items);
      } catch (error) {
        // 방금 만든 기준이라 가리키는 것이 없다 — 버전은 createVersion 이 이미 지웠다.
        await this.prisma.inspection_plan.delete({ where: { inspection_plan_id: plan } });
        throw error;
      }
      return;
    }

    await this.assertSamePlan(first, existing);
    const planId = Number(existing.inspection_plan_id);
    const versions = await this.prisma.inspection_plan_version.findMany({
      where: { inspection_plan_id: planId },
      orderBy: { plan_version: 'desc' },
      select: { inspection_plan_version_id: true, status_code: true },
    });
    if (versions.length === 0) {
      await this.createVersion(planId, first, items);
      return;
    }
    // 원본은 최신 확정 버전이다. 없으면 최신 버전을 넘겨 발행이 자기 문구로 거절하게 한다.
    const source = versions.find((v) => v.status_code === REVISION_STATUS.CONFIRMED) ?? versions[0];
    const versionId = await this.versions.newRevision(Number(source.inspection_plan_version_id));
    await this.fill(versionId, first, items, true);
  }

  private async createPlan(row: ImportRow): Promise<number> {
    const plan = row.plan;
    const missing: ErrorItem[] = [];
    if (plan.inspectionPlanName === null) missing.push(fail(row, 'inspectionPlanName', ERROR_CODE.REQUIRED, '새 기준코드라 기준명이 필요합니다.'));
    if (plan.inspectionTypeCode === null) missing.push(fail(row, 'inspectionTypeCode', ERROR_CODE.REQUIRED, '새 기준코드라 검사유형이 필요합니다.'));
    if (missing.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, missing);

    const created = await this.plans.create({
      inspectionPlanCode: plan.inspectionPlanCode,
      inspectionPlanName: plan.inspectionPlanName as string,
      inspectionTypeCode: plan.inspectionTypeCode as string,
      itemId: await this.idOf(row, 'itemCode', plan.itemCode),
      processId: await this.idOf(row, 'processCode', plan.processCode),
    });
    return created.inspectionPlanId;
  }

  private async createVersion(planId: number, row: ImportRow, items: Omit<ItemSpecUpsert, 'inspectionPlanVersionId'>[]): Promise<void> {
    const created = await this.versions.create({ inspectionPlanId: planId, ...versionWrite(row) }, DRAFT);
    await this.fill(created.inspectionPlanVersionId, row, items, false);
  }

  /** 버전 설정과 항목을 채운다. 실패하면 그 작성중 버전을 [작성 취소]로 지운다. */
  private async fill(
    versionId: number,
    row: ImportRow,
    items: Omit<ItemSpecUpsert, 'inspectionPlanVersionId'>[],
    copied: boolean,
  ): Promise<void> {
    try {
      if (copied) {
        // 발행은 원본 설정을 복사한다 — 엑셀의 버전 칸으로 덮는다.
        const { versionNo, inspectionPlanVersion: { samplingRatio } } = await this.versions.get(versionId);
        const write = versionWrite(row);
        // 엑셀에 비율이 없으면 확정 버전에서 사람이 넣은 비율을 이어 쓴다 — 다시 올릴 때마다 비율을 새로 넣지 않게.
        if (write.samplingRatio == null && write.samplingMethodCode !== 'FULL_INSPECTION') write.samplingRatio = samplingRatio;
        await this.versions.update(versionId, versionNo, write, DRAFT);
      }
      // 복사된 항목은 id 를 싣지 않았으므로 치환에서 빠진다 — 엑셀 항목만 남는다.
      await this.versions.replaceItems(versionId, items.map((item) => ({ ...item, inspectionPlanVersionId: versionId })));
    } catch (error) {
      await this.versions.discard(versionId);
      throw error;
    }
  }

  /** 있는 기준에 다른 유형·품목의 항목을 얹지 않는다 — 기준 머리는 엑셀로 바꾸지 않는다. */
  private async assertSamePlan(
    row: ImportRow,
    existing: { inspection_type_code: string; item_id: bigint | null },
  ): Promise<void> {
    const errors: ErrorItem[] = [];
    if (row.plan.inspectionTypeCode !== null && row.plan.inspectionTypeCode !== existing.inspection_type_code) {
      errors.push(fail(row, 'inspectionTypeCode', ERROR_CODE.INVALID, `이미 있는 기준의 검사유형(${existing.inspection_type_code})과 다릅니다.`));
    }
    if (row.plan.itemCode !== null) {
      const itemId = await this.idOf(row, 'itemCode', row.plan.itemCode);
      if (existing.item_id === null || BigInt(itemId ?? 0) !== existing.item_id) {
        errors.push(fail(row, 'itemCode', ERROR_CODE.INVALID, '이미 있는 기준의 품목과 다릅니다.'));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async items(rows: ImportRow[]): Promise<Omit<ItemSpecUpsert, 'inspectionPlanVersionId'>[]> {
    const items: Omit<ItemSpecUpsert, 'inspectionPlanVersionId'>[] = [];
    for (const [position, row] of rows.entries()) {
      const item = row.item;
      items.push({
        sequenceNo: item.sequenceNo ?? position + 1,
        inspectionItemCode: item.inspectionItemCode,
        inspectionItemName: item.inspectionItemName,
        nameKo: item.nameKo,
        nameVi: item.nameVi,
        dataTypeCode: item.dataTypeCode as string,
        uomId: await this.idOf(row, 'uomCode', item.uomCode),
        targetValue: item.targetValue,
        lowerLimit: item.lowerLimit,
        upperLimit: item.upperLimit,
        measurementCount: item.measurementCount ?? 1,
        inspectionMethodCode: item.inspectionMethodCode,
        // 비우면 화면의 항목 추가와 같은 기본값(DB 기본값)이다.
        requiredFlag: item.requiredFlag ?? true,
        automaticJudgment: item.automaticJudgment ?? true,
      });
    }
    return items;
  }

  /** 엑셀은 코드를 적는다 — 화면이 보내는 id 로 바꾼다. 비우면 `null`, 없는 코드는 그 행의 오류다. */
  private async idOf(row: ImportRow, field: 'itemCode' | 'processCode' | 'uomCode', code: string | null): Promise<number | null> {
    if (code === null) return null;
    const found =
      field === 'itemCode'
        ? (await this.prisma.item.findUnique({ where: { item_code: code }, select: { item_id: true } }))?.item_id
        : field === 'processCode'
          ? (await this.prisma.process.findUnique({ where: { process_code: code }, select: { process_id: true } }))?.process_id
          : (await this.prisma.uom.findUnique({ where: { uom_code: code }, select: { uom_id: true } }))?.uom_id;
    if (found === undefined) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [fail(row, field, ERROR_CODE.INVALID, `없는 코드입니다: ${code}`)]);
    }
    return Number(found);
  }
}

/** 샘플 비율은 비워도 된다 — 확정할 때 막는다(고객사 기준서는 개수뿐 · omf-all-around#201). */
const DRAFT = { allowMissingRatio: true } as const;

function versionWrite(row: ImportRow): VersionWrite {
  const v = row.version;
  return {
    effectiveFrom: v.effectiveFrom as string,
    effectiveTo: v.effectiveTo,
    samplingMethodCode: v.samplingMethodCode as string,
    samplingRatio: v.samplingRatio,
    aqlValue: v.aqlValue,
    acceptanceNumber: v.acceptanceNumber,
    rejectionNumber: v.rejectionNumber,
    inspectionFrequencyCode: v.inspectionFrequencyCode as string,
    frequencyIntervalValue: v.frequencyIntervalValue,
    frequencyIntervalUomCode: v.frequencyIntervalUomCode,
  };
}
