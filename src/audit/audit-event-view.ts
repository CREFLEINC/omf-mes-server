import { Prisma } from "@prisma/client";

type AuditEventRow = Prisma.audit_eventGetPayload<object>;

/** 계약 `AuditEvent` — JSON 변경분은 해석하거나 키를 버리지 않는다(B-5). */
export interface AuditEventView {
  auditEventId: number;
  occurredAt: string;
  targetTypeCode: string;
  targetId: number;
  eventTypeCode: string;
  beforeValue: Prisma.JsonValue | null;
  afterValue: Prisma.JsonValue | null;
  reason: string | null;
  performedBy: number | null;
  terminalId: number | null;
  correlationId: string | null;
}

export function auditEventView(row: AuditEventRow): AuditEventView {
  return {
    auditEventId: safeInt(row.audit_event_id, "auditEventId"),
    occurredAt: row.occurred_at.toISOString(),
    targetTypeCode: row.target_type_code,
    targetId: safeInt(row.target_id, "targetId"),
    eventTypeCode: row.event_type_code,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    reason: row.reason,
    performedBy: nullableSafeInt(row.performed_by, "performedBy"),
    terminalId: nullableSafeInt(row.terminal_id, "terminalId"),
    correlationId: row.correlation_id,
  };
}

function safeInt(value: bigint, field: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new RangeError(`${field}가 안전한 정수 범위를 벗어났습니다.`);
  return converted;
}

function nullableSafeInt(value: bigint | null, field: string): number | null {
  return value === null ? null : safeInt(value, field);
}
