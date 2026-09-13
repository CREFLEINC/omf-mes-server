import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import {
  DOCUMENT_TARGET_TYPES,
  DocumentTargetType,
  TargetLookup,
  targetKey,
} from './document-issue-target-lookup';
const DOCUMENT_TYPES = [
  'MATERIAL_LOT_LABEL',
  'GOODS_ISSUE_QR',
  'PRODUCTION_LOT_LABEL',
  'IDENTIFICATION_TAG',
  'PACKING_LABEL',
  'DELIVERY_LABEL',
  'CERTIFICATE_OF_ANALYSIS',
  'TOOL_LABEL',
  'LOCATION_LABEL',
] as const;
const PRINT_OUTCOMES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;

export interface DocumentTargetView {
  targetTypeCode: DocumentTargetType;
  targetId: number;
  displayName: string;
  screenId?: string;
}
export interface DocumentIssueView {
  documentIssueLogId: number;
  documentTypeCode: (typeof DOCUMENT_TYPES)[number];
  target: DocumentTargetView;
  lotId: number | null;
  lotNo: string | null;
  issueSeq: number;
  reissueReasonCode: string | null;
  reissueReasonName: string | null;
  issuedBy: number | null;
  issuedWorkerId: number | null;
  issuedByName: string;
  issuedAt: string;
  terminalId: number | null;
  terminalName?: string;
  printerName: string | null;
  printOutcome: (typeof PRINT_OUTCOMES)[number];
  remarks: string | null;
}

export const DOCUMENT_ISSUE_INCLUDE = {
  app_user: true,
  issued_worker: true,
  lot: true,
} satisfies Prisma.document_issue_logInclude;
export type DocumentIssueRow = Prisma.document_issue_logGetPayload<{
  include: typeof DOCUMENT_ISSUE_INCLUDE;
}>;
export type ReasonLookup = Map<string, string>;

export function documentIssueView(
  row: DocumentIssueRow,
  targets: TargetLookup,
  reasons: ReasonLookup,
): DocumentIssueView {
  const documentTypeCode = enumValue(
    row.document_type_code,
    DOCUMENT_TYPES,
    'documentTypeCode',
  );
  const targetTypeCode = enumValue(
    row.target_type_code,
    DOCUMENT_TARGET_TYPES,
    'targetTypeCode',
  );
  const targetId = safeInt(row.target_id, 'targetId');
  const foundTarget = targets.get(targetKey(targetTypeCode, row.target_id));
  const displayName = text(
    foundTarget?.displayName ?? `${targetTypeCode} #${targetId}`,
    200,
    'displayName',
  );
  const reasonCode = nullableText(
    row.reissue_reason_code,
    40,
    'reissueReasonCode',
  );
  const reasonName =
    reasonCode === null
      ? null
      : nullableText(reasons.get(reasonCode) ?? null, 200, 'reissueReasonName');
  const lotNo = nullableText(row.lot?.lot_no ?? null, 60, 'lotNo');

  return omitEmpty({
    documentIssueLogId: safeInt(
      row.document_issue_log_id,
      'documentIssueLogId',
    ),
    documentTypeCode,
    target: omitEmpty({
      targetTypeCode,
      targetId,
      displayName,
      screenId: foundTarget?.screenId,
    }),
    lotId: nullableInt(row.lot_id, 'lotId'),
    lotNo,
    issueSeq: positiveInt(row.issue_seq, 'issueSeq'),
    reissueReasonCode: reasonCode,
    reissueReasonName: reasonName,
    issuedBy: nullableInt(row.issued_by, 'issuedBy'),
    issuedWorkerId: nullableInt(row.issued_worker_id, 'issuedWorkerId'),
    issuedByName: text(issuerName(row.app_user?.user_name, row.issued_worker?.worker_name), 200, 'issuedByName'),
    issuedAt: row.issued_at.toISOString(),
    terminalId: nullableInt(row.terminal_id, 'terminalId'),
    printerName: nullableText(row.printer_name, 100, 'printerName'),
    printOutcome: enumValue(
      row.print_outcome_code,
      PRINT_OUTCOMES,
      'printOutcome',
    ),
    remarks: row.remarks,
  });
}

function issuerName(accountName: string | undefined, workerName: string | undefined): string {
  const name = accountName ?? workerName;
  if (!name) throw new Error('Document issue actor is missing');
  return name;
}

function enumValue<T extends string>(
  value: string | null,
  values: readonly T[],
  field: string,
): T {
  if (value === null || value.length > 40 || !values.includes(value as T))
    throw new Error(`Invalid stored document issue field: ${field}`);
  return value as T;
}

function text(value: string, max: number, field: string): string {
  if (value.length > max)
    throw new Error(`Stored document issue field exceeds contract: ${field}`);
  return value;
}

function nullableText(
  value: string | null,
  max: number,
  field: string,
): string | null {
  return value === null ? null : text(value, max, field);
}

function safeInt(value: bigint, field: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new Error(
      `Stored document issue integer exceeds safe range: ${field}`,
    );
  return converted;
}

function nullableInt(value: bigint | null, field: string): number | null {
  return value === null ? null : safeInt(value, field);
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid stored document issue integer: ${field}`);
  return value;
}
