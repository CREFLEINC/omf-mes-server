import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  field,
} from "../../common/errors";
import {
  DocumentIssueDocumentType,
  PreparedDocumentIssueTarget,
} from "./document-issue-create-rules";
import { targetKey } from "./document-issue-target-lookup";

const MAX_ISSUE_SEQ = 2_147_483_647;
const MAX_ATTEMPTS = 3;
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);
const ISSUE_SEQUENCE_COLUMNS = [
  "document_type_code",
  "target_type_code",
  "target_id",
  "issue_seq",
].sort();

type Tx = Prisma.TransactionClient;

interface SequenceRow {
  target_type_code: PreparedDocumentIssueTarget["targetTypeCode"];
  target_id: bigint;
  max_issue_seq: number;
}

export interface DocumentIssueSequence {
  current: number;
  next: number;
}

/** 부모 잠금 뒤 업무 경로가 달라졌음을 나타내는 내부 전용 재시도 신호다. */
export class DocumentIssueTargetPathChanged extends Error {}

/** 부모를 모두 잠근 뒤 대상별 현재 최대 회차를 한 문장으로 읽는다. */
export async function nextDocumentIssueSequences(
  tx: Tx,
  documentTypeCode: DocumentIssueDocumentType,
  targets: PreparedDocumentIssueTarget[],
): Promise<Map<string, DocumentIssueSequence>> {
  if (targets.length === 0) return new Map();
  const sorted = [...targets].sort(targetOrder);
  const targetByKey = new Map(
    sorted.map((target) => [
      targetKey(target.targetTypeCode, target.targetId),
      target,
    ]),
  );
  const requested = Prisma.join(
    sorted.map(
      (target) =>
        Prisma.sql`(${target.targetTypeCode}::varchar,${target.targetId}::bigint)`,
    ),
  );
  const rows = await tx.$queryRaw<SequenceRow[]>(Prisma.sql`
    WITH requested(target_type_code,target_id) AS (VALUES ${requested})
    SELECT requested.target_type_code,requested.target_id,
           COALESCE(MAX(log.issue_seq),0)::int AS max_issue_seq
    FROM requested
    LEFT JOIN app.document_issue_log AS log
      ON log.document_type_code = ${documentTypeCode}
     AND log.target_type_code = requested.target_type_code
     AND log.target_id = requested.target_id
    GROUP BY requested.target_type_code,requested.target_id
    ORDER BY requested.target_type_code,requested.target_id`);

  return new Map(
    rows.map((row) => {
      const target = targetByKey.get(
        targetKey(row.target_type_code, row.target_id),
      );
      if (target === undefined)
        throw new Error("발행 회차 조회 결과가 요청과 일치하지 않습니다.");
      if (row.max_issue_seq >= MAX_ISSUE_SEQ)
        throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
          field(
            `targets[${target.index}].targetId`,
            ERROR_CODE.RANGE,
            "발행 회차 범위를 초과했습니다.",
          ),
        ]);
      return [
        targetKey(target.targetTypeCode, target.targetId),
        { current: row.max_issue_seq, next: row.max_issue_seq + 1 },
      ];
    }),
  );
}

/** 실패한 트랜잭션 전체를 최초 포함 최대 세 번만 다시 실행한다. */
export async function runDocumentIssueWriteWithRetry<T>(
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt >= MAX_ATTEMPTS)
        throw new ConflictException(
          "user",
          "문서 발행이 다른 요청과 계속 충돌했습니다. 다시 시도해 주세요.",
        );
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof DocumentIssueTargetPathChanged) return true;
  if (sqlStateOf(error) !== undefined) return true;
  return isIssueSequenceDuplicate(error);
}

function sqlStateOf(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") return error.code;
    const state = String((error.meta ?? {}).code ?? "");
    return RETRYABLE_SQLSTATES.has(state) ? state : undefined;
  }
  if (typeof error !== "object" || error === null) return undefined;
  const state = String((error as { code?: unknown }).code ?? "");
  return RETRYABLE_SQLSTATES.has(state) ? state : undefined;
}

function isIssueSequenceDuplicate(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  )
    return false;
  const target = (error.meta ?? {}).target;
  if (target === "uq_document_issue_log") return true;
  if (!Array.isArray(target)) return false;
  return (
    target.length === ISSUE_SEQUENCE_COLUMNS.length &&
    target.map(String).sort().join("|") === ISSUE_SEQUENCE_COLUMNS.join("|")
  );
}

function targetOrder(
  left: PreparedDocumentIssueTarget,
  right: PreparedDocumentIssueTarget,
): number {
  const type = left.targetTypeCode.localeCompare(right.targetTypeCode);
  if (type !== 0) return type;
  return left.targetId < right.targetId
    ? -1
    : left.targetId > right.targetId
      ? 1
      : 0;
}
