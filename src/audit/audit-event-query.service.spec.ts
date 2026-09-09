import { Prisma } from "@prisma/client";

import {
  AUDIT_EVENT_ORDER_BY,
  buildAuditEventWhere,
} from "./audit-event-query.service";
import { auditEventView } from "./audit-event-view";

describe("감사 이력 조회 규칙", () => {
  it("기간은 반개구간이고 선택 필터 다섯을 빠짐없이 건다", () => {
    expect(
      buildAuditEventWhere({
        occurredFrom: "2026-09-01T00:00:00.000Z",
        occurredTo: "2026-09-02T00:00:00.000Z",
        targetTypeCode: "ITEM",
        targetId: 11,
        eventTypeCode: "UPDATE",
        performedBy: 12,
        correlationId: "AUDIT-1",
      }),
    ).toEqual({
      occurred_at: {
        gte: new Date("2026-09-01T00:00:00.000Z"),
        lt: new Date("2026-09-02T00:00:00.000Z"),
      },
      target_type_code: "ITEM",
      target_id: 11n,
      event_type_code: "UPDATE",
      performed_by: 12n,
      correlation_id: "AUDIT-1",
    });
  });

  it("정렬은 시각 desc 뒤 PK desc다", () => {
    expect(AUDIT_EVENT_ORDER_BY).toEqual([
      { occurred_at: "desc" },
      { audit_event_id: "desc" },
    ]);
  });

  it("required·nullable·JSON 칸을 물리 원천 그대로 투영한다", () => {
    const row: Prisma.audit_eventGetPayload<object> = {
      audit_event_id: 101n,
      occurred_at: new Date("2026-09-01T01:02:03.456Z"),
      target_type_code: "ITEM",
      target_id: 202n,
      event_type_code: "UPDATE",
      before_value: { unknownBefore: "kept", isActive: true },
      after_value: { unknownAfter: 7, isActive: false },
      reason: null,
      performed_by: 303n,
      terminal_id: null,
      correlation_id: "AUDIT-CORRELATION",
    };

    expect(auditEventView(row)).toEqual({
      auditEventId: 101,
      occurredAt: "2026-09-01T01:02:03.456Z",
      targetTypeCode: "ITEM",
      targetId: 202,
      eventTypeCode: "UPDATE",
      beforeValue: { unknownBefore: "kept", isActive: true },
      afterValue: { unknownAfter: 7, isActive: false },
      reason: null,
      performedBy: 303,
      terminalId: null,
      correlationId: "AUDIT-CORRELATION",
    });
  });
});
