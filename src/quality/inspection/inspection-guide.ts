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
 * 의뢰의 검사 안내 — 의뢰가 쓰는 기준 버전의 문구. 옛 「전 품목 공통」 기준으로 선 의뢰는 그 문구가 COMMON 이다.
 * 품목 전용 기준에 공통 기준 문구를 덧붙이던 것은 공통 기준과 함께 없앴다(omf-all-around#366).
 */
export async function inspectionGuides(
  prisma: PrismaService,
  request: { inspection_plan_version_id: bigint | null; requested_at: Date },
): Promise<InspectionGuideView[]> {
  if (request.inspection_plan_version_id === null) return [];
  const version = await prisma.inspection_plan_version.findUnique({
    where: { inspection_plan_version_id: request.inspection_plan_version_id },
    select: { guide_text: true, inspection_plan: { select: { item_id: true } } },
  });
  if (!version || !hasText(version)) return [];
  return [guideOf(version.inspection_plan.item_id === null ? 'COMMON' : 'ITEM', version)];
}
