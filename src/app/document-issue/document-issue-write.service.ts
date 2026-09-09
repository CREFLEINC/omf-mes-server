import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import {
  DocumentIssueCreateInput,
  DocumentIssueTargetFacts,
  PreparedDocumentIssueTarget,
  assertReissueReason,
  prepareDocumentIssueTargets,
  qualifyDocumentIssueTarget,
} from "./document-issue-create-rules";
import { lockDocumentIssueGoodsIssueTargets } from "./document-issue-goods-issue-lock";
import { loadDocumentIssueReasons } from "./document-issue-query.service";
import {
  DocumentIssueSequence,
  nextDocumentIssueSequences,
} from "./document-issue-sequence";
import { lockSimpleDocumentIssueTargets } from "./document-issue-simple-lock";
import {
  targetKey,
  loadDocumentIssueTargets,
} from "./document-issue-target-lookup";
import { assertDocumentIssueTerminalPermission } from "./document-issue-terminal-permission";
import {
  DOCUMENT_ISSUE_INCLUDE,
  DocumentIssueView,
  documentIssueView,
} from "./document-issue-view";
import { DocumentIssueWriteContext } from "./document-issue-write-context";

interface QualifiedTarget {
  target: PreparedDocumentIssueTarget;
  lotId: bigint | null;
  sequence: DocumentIssueSequence;
}

export interface DocumentIssueBatchResponse {
  items: DocumentIssueView[];
  issuedCount: number;
}

@Injectable()
export class DocumentIssueWriteService {
  async issueWithin(
    tx: Prisma.TransactionClient,
    input: DocumentIssueCreateInput,
    context: DocumentIssueWriteContext,
  ): Promise<DocumentIssueBatchResponse> {
    const targets = prepareDocumentIssueTargets(input);
    assertWriterReady(input.documentTypeCode);
    const facts = mergeFacts(
      await lockSimpleDocumentIssueTargets(tx, input.documentTypeCode, targets),
      await lockDocumentIssueGoodsIssueTargets(tx, targets),
    );
    const sequences = await nextDocumentIssueSequences(
      tx,
      input.documentTypeCode,
      targets,
    );
    const qualified = targets.map((target) => ({
      target,
      lotId: qualifyDocumentIssueTarget(
        input.documentTypeCode,
        target,
        facts.get(targetKey(target.targetTypeCode, target.targetId)),
      ),
      sequence: requiredSequence(sequences, target),
    }));
    await assertDocumentIssueTerminalPermission(
      tx,
      input.documentTypeCode,
      context.terminalId,
      facts.values(),
    );
    const workerId = await resolveWorker(tx, context.workerNo);
    const reason = await resolveReason(tx, input, qualified);
    const now = new Date();
    const created = await tx.document_issue_log.createManyAndReturn({
      data: qualified.map(({ target, lotId, sequence }) => ({
        document_type_code: input.documentTypeCode,
        target_type_code: target.targetTypeCode,
        target_id: target.targetId,
        lot_id: lotId,
        issue_seq: sequence.next,
        reissue_reason_code: sequence.current === 0 ? null : reason,
        issued_by: BigInt(context.appUserId),
        issued_at: now,
        terminal_id: context.terminalId,
        printer_name: input.printerName ?? null,
        remarks: input.remarks ?? null,
        print_outcome_code: "PENDING",
        print_failure_reason: null,
        print_reported_at: null,
        issued_worker_id: workerId,
        print_reported_worker_id: null,
        print_reported_by: null,
      })),
      select: {
        document_issue_log_id: true,
        document_type_code: true,
        target_type_code: true,
        target_id: true,
        issue_seq: true,
      },
    });
    const ids = createdIds(input.documentTypeCode, qualified, created);
    const rows = await tx.document_issue_log.findMany({
      where: { document_issue_log_id: { in: ids } },
      include: DOCUMENT_ISSUE_INCLUDE,
    });
    if (rows.length !== qualified.length)
      throw new Error("생성한 발행 기록을 모두 다시 읽지 못했습니다.");
    const [targetViews, reasons] = await Promise.all([
      loadDocumentIssueTargets(tx, rows),
      loadDocumentIssueReasons(tx, rows),
    ]);
    const views = new Map(
      rows.map((row) => [
        issueKey(
          row.document_type_code,
          row.target_type_code,
          row.target_id,
          row.issue_seq,
        ),
        documentIssueView(row, targetViews, reasons),
      ]),
    );
    const items = qualified.map(({ target, sequence }) => {
      const view = views.get(
        issueKey(
          input.documentTypeCode,
          target.targetTypeCode,
          target.targetId,
          sequence.next,
        ),
      );
      if (view === undefined)
        throw new Error("발행 응답이 원래 대상 순서와 일치하지 않습니다.");
      return view;
    });
    return { items, issuedCount: items.length };
  }
}

function assertWriterReady(documentTypeCode: string): void {
  if (documentTypeCode !== "CERTIFICATE_OF_ANALYSIS") return;
  throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
    field(
      "documentTypeCode",
      ERROR_CODE.STATE_LOCKED,
      "검사 확정과 성적서 발행의 잠금 순서가 조율되지 않았습니다.",
    ),
  ]);
}

function mergeFacts(
  ...maps: Map<string, DocumentIssueTargetFacts>[]
): Map<string, DocumentIssueTargetFacts> {
  return new Map(maps.flatMap((map) => [...map]));
}

function requiredSequence(
  sequences: Map<string, DocumentIssueSequence>,
  target: PreparedDocumentIssueTarget,
): DocumentIssueSequence {
  const sequence = sequences.get(
    targetKey(target.targetTypeCode, target.targetId),
  );
  if (sequence === undefined)
    throw new Error("발행 회차 조회 결과가 요청에서 누락됐습니다.");
  return sequence;
}

async function resolveWorker(
  tx: Prisma.TransactionClient,
  workerNo: string | undefined,
): Promise<bigint | null> {
  if (workerNo === undefined) return null;
  const worker = await tx.worker.findUnique({
    where: { worker_no: workerNo },
    select: { worker_id: true },
  });
  if (worker === null)
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field("X-Worker-No", ERROR_CODE.INVALID, "없는 작업자 사번입니다."),
    ]);
  return worker.worker_id;
}

async function resolveReason(
  tx: Prisma.TransactionClient,
  input: DocumentIssueCreateInput,
  qualified: QualifiedTarget[],
): Promise<string | null> {
  const raw = input.reissueReasonCode;
  const present = typeof raw === "string" && raw.trim() !== "";
  const active = present
    ? (await tx.code_value.findFirst({
        where: {
          code: raw,
          is_active: true,
          code_group: { group_code: "REISSUE_REASON", is_active: true },
        },
        select: { code_value_id: true },
      })) !== null
    : false;
  return assertReissueReason(
    qualified.some(({ sequence }) => sequence.current > 0),
    raw,
    active,
  );
}

function createdIds(
  documentTypeCode: string,
  qualified: QualifiedTarget[],
  rows: Array<{
    document_issue_log_id: bigint;
    document_type_code: string;
    target_type_code: string;
    target_id: bigint;
    issue_seq: number;
  }>,
): bigint[] {
  const ids = new Map(
    rows.map((row) => [
      issueKey(
        row.document_type_code,
        row.target_type_code,
        row.target_id,
        row.issue_seq,
      ),
      row.document_issue_log_id,
    ]),
  );
  return qualified.map(({ target, sequence }) => {
    const id = ids.get(
      issueKey(
        documentTypeCode,
        target.targetTypeCode,
        target.targetId,
        sequence.next,
      ),
    );
    if (id === undefined || ids.size !== qualified.length)
      throw new Error("생성된 발행 기록 키가 요청과 일치하지 않습니다.");
    return id;
  });
}

function issueKey(
  documentTypeCode: string,
  targetTypeCode: string,
  targetId: bigint,
  issueSeq: number,
): string {
  return `${documentTypeCode}:${targetTypeCode}:${targetId}:${issueSeq}`;
}
