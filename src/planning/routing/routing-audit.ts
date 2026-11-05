import { Prisma } from '@prisma/client';

import { changedFields } from '../../quality/inspection-plan/inspection-plan-version-audit';

/**
 * Routing(Rev)의 변경 이력(omf-all-around#231) — `audit.audit_event` 에 남기고 `GET /audit/events` 가 읽는다.
 *
 * 저장 규약은 검사기준 버전 이력과 같다 — 키는 계약 필드 이름(camelCase), **바뀐 키만**, 코드값은 코드만.
 * 이벤트 유형은 CREATE · UPDATE · DELETE(작성중 Rev 취소).
 * ⛔ 업무 쓰기와 **같은 트랜잭션**에서 부른다 — 이력 없이 바뀐 Rev 가 생기지 않게.
 */
export const ROUTING_AUDIT_TARGET = 'ROUTING';

type Fields = Record<string, unknown>;

export interface RoutingAudit {
  routingId: number | bigint;
  eventTypeCode: 'CREATE' | 'UPDATE' | 'DELETE';
  /** 세션 사용자. 세션 없이 부르는 내부 경로는 null 이다. */
  actorId: number | null | undefined;
  before?: Fields | null;
  after?: Fields | null;
}

export async function recordRoutingAudit(
  tx: Prisma.TransactionClient,
  audit: RoutingAudit,
): Promise<void> {
  await tx.audit_event.create({
    data: {
      occurred_at: new Date(),
      target_type_code: ROUTING_AUDIT_TARGET,
      target_id: BigInt(audit.routingId),
      event_type_code: audit.eventTypeCode,
      performed_by:
        audit.actorId === null || audit.actorId === undefined ? null : BigInt(audit.actorId),
      before_value: toJson(audit.before),
      after_value: toJson(audit.after),
    },
  });
}

/** 바뀐 키만 남긴 UPDATE 를 적는다. 바뀐 것이 없으면 적지 않는다. */
export async function recordRoutingChange(
  tx: Prisma.TransactionClient,
  routingId: number | bigint,
  actorId: number | null | undefined,
  before: Fields,
  after: Fields,
): Promise<void> {
  const diff = changedFields(before, after);
  if (Object.keys(diff.before).length === 0 && Object.keys(diff.after).length === 0) return;
  await recordRoutingAudit(tx, { routingId, eventTypeCode: 'UPDATE', actorId, ...diff });
}

function toJson(value: Fields | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
