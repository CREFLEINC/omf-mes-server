import { latestPerPlan } from '../../core/quality/inspection-plan-version';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `InspectionGuide` 와 동형(omf-all-around#252). */
export interface InspectionGuideView {
  scopeCode: 'COMMON' | 'ITEM';
  guideText: string;
}

type GuideSource = { guide_text: string | null };

const hasText = (row: GuideSource): boolean => (row.guide_text ?? '').trim() !== '';

const guideOf = (scopeCode: InspectionGuideView['scopeCode'], row: GuideSource): InspectionGuideView => ({
  scopeCode,
  guideText: row.guide_text ?? '',
});

/**
 * 의뢰의 검사 안내 — 의뢰가 쓰는 기준 버전의 문구, 그 기준이 품목 전용이면 «의뢰 날짜에 유효한» 전 품목 공통 기준의 문구를
 * 함께(공통이 앞). 모든 품목 기준서에 같은 안내(NG 확인 · 측정값 기록 · 측정기 약어)가 있어 공통 기준 한 곳에만 적게 한다
 * (사용자 결정 2026-11-10). 공통 기준이 둘 이상이면 어느 것인지 몰라 싣지 않는다 — 의뢰 기준 고르기와 같은 판단이다.
 */
export async function inspectionGuides(
  prisma: PrismaService,
  request: { inspection_plan_version_id: bigint | null; requested_at: Date },
): Promise<InspectionGuideView[]> {
  if (request.inspection_plan_version_id === null) return [];
  const version = await prisma.inspection_plan_version.findUnique({
    where: { inspection_plan_version_id: request.inspection_plan_version_id },
    select: {
      guide_text: true,
      inspection_plan: { select: { item_id: true, inspection_type_code: true } },
    },
  });
  if (!version) return [];
  if (version.inspection_plan.item_id === null) return hasText(version) ? [guideOf('COMMON', version)] : [];

  const date = new Date(request.requested_at.toISOString().slice(0, 10));
  const commons = latestPerPlan(await prisma.inspection_plan_version.findMany({
    where: {
      status_code: 'CONFIRMED',
      effective_from: { lte: date },
      OR: [{ effective_to: null }, { effective_to: { gte: date } }],
      inspection_plan: { item_id: null, inspection_type_code: version.inspection_plan.inspection_type_code, is_active: true },
    },
    select: { inspection_plan_id: true, plan_version: true, guide_text: true },
  }));
  return [
    ...(commons.length === 1 && hasText(commons[0]) ? [guideOf('COMMON', commons[0])] : []),
    ...(hasText(version) ? [guideOf('ITEM', version)] : []),
  ];
}
