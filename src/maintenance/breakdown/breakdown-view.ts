import { Prisma } from '@prisma/client';

export const BREAKDOWN_INCLUDE = {
  equipment: { select: { equipment_code: true } },
} satisfies Prisma.breakdownInclude;

export type BreakdownRow = Prisma.breakdownGetPayload<{
  include: typeof BREAKDOWN_INCLUDE;
}>;

export interface BreakdownView {
  breakdownId: number;
  breakdownNo: string;
  equipmentId: number;
  equipmentCode: string;
  symptom: string;
  occurrenceStateCode: string;
  stoppedAt: string | null;
  reportedAt: string;
  reporterWorkerNo: string;
  statusCode: 'RECEIVED' | 'HANDLING' | 'DONE';
  notifyAssignee?: boolean;
  linkedDowntimeCount: number;
  linkedDowntimeMinutes?: number | null;
  openLinkedDowntimeCount?: number;
  handling: {
    causeCode: string | null;
    handlingNote: string | null;
    handledByUserId: number | null;
    handledAt: string | null;
    maintenanceOrderId: number | null;
  };
  attachments: [];
}

export interface BreakdownDetailAggregate {
  linkedDowntimeCount: number;
  linkedDowntimeMinutes: number | null;
  openLinkedDowntimeCount: number;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Missing required breakdown field');
  return value;
}

function statusCode(value: string): BreakdownView['statusCode'] {
  if (value !== 'RECEIVED' && value !== 'HANDLING' && value !== 'DONE')
    throw new Error('Invalid stored breakdown status');
  return value;
}

export function breakdownView(
  row: BreakdownRow,
  maintenanceOrderId: number | null,
  detail?: BreakdownDetailAggregate,
): BreakdownView {
  const view: BreakdownView = {
    breakdownId: Number(required(row.breakdown_id)),
    breakdownNo: row.breakdown_no,
    equipmentId: Number(required(row.equipment_id)),
    equipmentCode: row.equipment.equipment_code,
    symptom: required(row.description),
    occurrenceStateCode: required(row.occurrence_state_code),
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    reportedAt: required(row.reported_at).toISOString(),
    reporterWorkerNo: required(row.reporter_worker_no),
    statusCode: statusCode(row.status_code),
    linkedDowntimeCount: detail?.linkedDowntimeCount ?? 0,
    handling: {
      causeCode: row.cause_code,
      handlingNote: row.handling_note,
      handledByUserId: row.handled_by === null ? null : Number(row.handled_by),
      handledAt: row.handled_at?.toISOString() ?? null,
      maintenanceOrderId,
    },
    attachments: [],
  };
  if (row.notify_assignee !== null) view.notifyAssignee = row.notify_assignee;
  if (detail) {
    view.linkedDowntimeMinutes = detail.linkedDowntimeMinutes;
    view.openLinkedDowntimeCount = detail.openLinkedDowntimeCount;
  }
  return view;
}
