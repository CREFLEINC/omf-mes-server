import { Prisma } from '@prisma/client';

import type { InspectionSheetTemplateUpdate } from './inspection-sheet-template.service';

/**
 * 검사표 기준 버전의 변경 이력(omf-all-around#214) — 검사기준 버전(#196 · `inspection-plan-version-audit.ts`)과
 * 같은 규약으로 `audit.audit_event` 에 남기고 `GET /audit/events` 가 읽는다. 기준 한 행이 곧 한 버전이라
 * 대상 식별자는 `inspection_sheet_template_id` 다.
 *
 * 키는 계약 필드 이름(camelCase), **바뀐 키만**, 코드값은 코드만. 단계·LOT 칸은 배열 통째로 견준다 — 바뀌면
 * `steps`·`lotSources` 키에 앞뒤 전체를 담는다(서버가 매기는 식별자는 빼고).
 * ⛔ 업무 쓰기와 **같은 트랜잭션**에서 부른다 — 이력 없이 바뀐 버전이 생기지 않게.
 */
export const SHEET_TEMPLATE_AUDIT_TARGET = 'INSPECTION_SHEET_TEMPLATE';

type Fields = Record<string, unknown>;

export interface SheetTemplateAudit {
  templateId: number | bigint;
  eventTypeCode: 'CREATE' | 'UPDATE' | 'DELETE';
  actorId: number;
  before?: Fields | null;
  after?: Fields | null;
}

export async function recordSheetTemplateAudit(
  tx: Prisma.TransactionClient,
  audit: SheetTemplateAudit,
): Promise<void> {
  await tx.audit_event.create({
    data: {
      occurred_at: new Date(),
      target_type_code: SHEET_TEMPLATE_AUDIT_TARGET,
      target_id: BigInt(audit.templateId),
      event_type_code: audit.eventTypeCode,
      performed_by: BigInt(audit.actorId),
      before_value: toJson(audit.before),
      after_value: toJson(audit.after),
    },
  });
}

/** 상태만 바뀐 이력 — 확정 · 폐기(손으로 · 새 버전 확정으로). */
export function statusAudit(templateId: number | bigint, from: string, to: string, actorId: number): SheetTemplateAudit {
  return { templateId, eventTypeCode: 'UPDATE', actorId, before: { statusCode: from }, after: { statusCode: to } };
}

/** 고칠 수 있는 내용 — 머리 칸 · LOT 칸 · 단계와 항목. 계약 `InspectionSheetTemplateUpdate` 의 모양이다. */
export function contentOf(input: InspectionSheetTemplateUpdate): Fields {
  return {
    materialText: input.materialText ?? null,
    structureText: input.structureText ?? null,
    rohsFlag: input.rohsFlag,
    productNameText: input.productNameText ?? null,
    powerText: input.powerText ?? null,
    motorText: input.motorText ?? null,
    remarks: input.remarks ?? null,
    lotSources: input.lotSources.map((source) => ({ slotCode: source.slotCode, itemId: Number(source.itemId) })),
    steps: input.steps.map((step) => ({
      stepCode: step.stepCode,
      nameKo: step.nameKo,
      nameVi: step.nameVi ?? null,
      signRequired: step.signRequired,
      items: step.items.map((item) => ({
        checkItemCode: item.checkItemCode,
        nameKo: item.nameKo,
        nameVi: item.nameVi ?? null,
        methodCode: item.methodCode,
      })),
    })),
  };
}

/** 두 값에서 다른 키만 남긴다. 바뀐 것이 없으면 null — 이력을 남기지 않는다. */
export function contentChanges(before: Fields, after: Fields): { before: Fields; after: Fields } | null {
  const changed = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (changed.length === 0) return null;
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}

function toJson(value: Fields | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
