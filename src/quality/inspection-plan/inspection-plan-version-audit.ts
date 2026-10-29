import { Prisma } from '@prisma/client';

/**
 * 검사기준 버전의 변경 이력(omf-all-around#196) — `audit.audit_event` 에 남기고 `GET /audit/events` 가 읽는다.
 *
 * 저장 규약은 계약 `AuditEvent.beforeValue/afterValue` 설명 그대로다 — 키는 계약 필드 이름(camelCase),
 * **바뀐 키만**, 코드값은 코드만. 이벤트 유형은 `AUDIT_EVENT_TYPE` 의 CREATE · UPDATE · DELETE 만 쓴다.
 * ⛔ 업무 쓰기와 **같은 트랜잭션**에서 부른다 — 이력 없이 바뀐 버전이 생기지 않게.
 */
export const PLAN_VERSION_AUDIT_TARGET = 'INSPECTION_PLAN_VERSION';

type Fields = Record<string, unknown>;

export interface PlanVersionAudit {
  versionId: number;
  eventTypeCode: 'CREATE' | 'UPDATE' | 'DELETE';
  /** 세션 사용자. 세션 없이 부르는 내부 경로(엑셀 올리기 등)는 null 이다. */
  actorId: number | null | undefined;
  before?: Fields | null;
  after?: Fields | null;
}

export async function recordPlanVersionAudit(
  tx: Prisma.TransactionClient,
  audit: PlanVersionAudit,
): Promise<void> {
  await tx.audit_event.create({
    data: {
      occurred_at: new Date(),
      target_type_code: PLAN_VERSION_AUDIT_TARGET,
      target_id: BigInt(audit.versionId),
      event_type_code: audit.eventTypeCode,
      performed_by: audit.actorId === null || audit.actorId === undefined ? null : BigInt(audit.actorId),
      before_value: toJson(audit.before),
      after_value: toJson(audit.after),
    },
  });
}

/** 두 값에서 다른 키만 남긴다. 한쪽에만 있는 키도 변경분이다(계약). `ignore` 키는 견주지 않는다. */
export function changedFields(
  before: Fields,
  after: Fields,
  ignore: readonly string[] = [],
): { before: Fields; after: Fields } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter(
    (key) => !ignore.includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return {
    before: Object.fromEntries(changed.filter((key) => key in before).map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.filter((key) => key in after).map((key) => [key, after[key]])),
  };
}

/** 검사 항목 칸 가운데 견주지 않는 것 — 서버가 매기는 식별자다. */
const ITEM_IGNORED = ['inspectionItemSpecId', 'inspectionPlanVersionId'];

/**
 * 검사 항목 전체 치환의 변경분 — **항목코드로 짝짓는다**(식별자는 새 항목에 없다).
 * 바뀐 항목만 `items` 에 담고, 항목마다 `inspectionItemCode` 와 바뀐 칸만 둔다. 추가는 after 에만, 삭제는 before 에만 선다.
 * 바뀐 것이 없으면 null — 이력을 남기지 않는다.
 */
export function itemChanges(
  before: readonly Fields[],
  after: readonly Fields[],
): { before: Fields; after: Fields } | null {
  const codeOf = (item: Fields): string => String(item.inspectionItemCode);
  const beforeByCode = new Map(before.map((item) => [codeOf(item), item]));
  const afterCodes = new Set(after.map(codeOf));
  const beforeItems: Fields[] = [];
  const afterItems: Fields[] = [];

  for (const item of after) {
    const old = beforeByCode.get(codeOf(item));
    if (old === undefined) {
      afterItems.push(changedFields({}, item, ITEM_IGNORED).after);
      continue;
    }
    const diff = changedFields(old, item, ITEM_IGNORED);
    if (Object.keys(diff.after).length === 0 && Object.keys(diff.before).length === 0) continue;
    beforeItems.push({ inspectionItemCode: codeOf(item), ...diff.before });
    afterItems.push({ inspectionItemCode: codeOf(item), ...diff.after });
  }
  for (const item of before) {
    if (!afterCodes.has(codeOf(item))) beforeItems.push(changedFields(item, {}, ITEM_IGNORED).before);
  }

  if (beforeItems.length === 0 && afterItems.length === 0) return null;
  return { before: { items: beforeItems }, after: { items: afterItems } };
}

function toJson(value: Fields | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
