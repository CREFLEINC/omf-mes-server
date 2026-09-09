import { HttpStatus } from "@nestjs/common";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { DocumentTargetType } from "./document-issue-target-lookup";
import { DocumentIssueView } from "./document-issue-view";

// 변경 비용이 낮은 발행 가장자리는 원문을 보존하는 거부 정책으로 서버가 결정했다.
// 결정 — 통보(레인 B), `docs/design-inquiries/재정리-2026-09-08-레인B.md` §5.
export const MATERIAL_LABEL_UNRESOLVED_STATE_POLICY = {
  code: ERROR_CODE.STATE_LOCKED,
  message: "자재 LOT 라벨을 발행할 수 없는 상태입니다.",
} as const;
export const IDENTIFICATION_LABEL_ELIGIBILITY_POLICY = {
  code: ERROR_CODE.STATE_LOCKED,
  message: "개체별 발행 자격 원천이 확정되지 않았습니다.",
} as const;
export const DELIVERY_ALLOCATION_TARGET_POLICY = {
  code: ERROR_CODE.INVALID,
  message: "납품 라벨의 대상 유형이 계약에 없습니다.",
} as const;

export type DocumentIssueDocumentType = DocumentIssueView["documentTypeCode"];

export interface DocumentIssueCreateTargetInput {
  targetTypeCode: DocumentTargetType;
  targetId: number;
  lotId?: number | null;
}

export interface DocumentIssueCreateInput {
  documentTypeCode: DocumentIssueDocumentType;
  targets: DocumentIssueCreateTargetInput[];
  reissueReasonCode?: string | null;
  printerName?: string | null;
  remarks?: string | null;
}

export interface PreparedDocumentIssueTarget {
  index: number;
  targetTypeCode: DocumentTargetType;
  targetId: bigint;
  requestedLotId: bigint | null;
}

export type DocumentIssueTargetFacts =
  | {
      targetTypeCode: "LOT";
      targetId: bigint;
      lotTypeCode: string;
      statusCode: string;
      completedAt: Date | null;
      sourceTypeCode?: string;
      sourceId?: bigint;
    }
  | {
      targetTypeCode: "SERIAL_NUMBER";
      targetId: bigint;
      lotId: bigint;
    }
  | {
      targetTypeCode: "HANDLING_UNIT";
      targetId: bigint;
      hasContent?: boolean;
    }
  | {
      targetTypeCode: "GOODS_ISSUE_LINE";
      targetId: bigint;
      lotId: bigint;
      goodsIssueStatusCode: string;
    }
  | { targetTypeCode: "MOLD"; targetId: bigint }
  | { targetTypeCode: "LOCATION"; targetId: bigint }
  | {
      targetTypeCode: "INSPECTION_RESULT";
      targetId: bigint;
      lotId: bigint | null;
      statusCode: string;
      confirmedAt: Date | null;
    };

export function prepareDocumentIssueTargets(
  input: DocumentIssueCreateInput,
): PreparedDocumentIssueTarget[] {
  const seen = new Set<string>();
  return input.targets.map((target, index) => {
    assertSafeId(target.targetId, `targets[${index}].targetId`);
    if (target.lotId !== undefined && target.lotId !== null)
      assertSafeId(target.lotId, `targets[${index}].lotId`);
    assertSupportedPair(input.documentTypeCode, target.targetTypeCode, index);

    const key = `${target.targetTypeCode}:${target.targetId}`;
    if (seen.has(key))
      fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `targets[${index}].targetId`,
        ERROR_CODE.INVALID,
        "같은 발행 대상은 한 요청에 한 번만 지정할 수 있습니다.",
      );
    seen.add(key);

    return {
      index,
      targetTypeCode: target.targetTypeCode,
      targetId: BigInt(target.targetId),
      requestedLotId:
        target.lotId === undefined || target.lotId === null
          ? null
          : BigInt(target.lotId),
    };
  });
}

export function qualifyDocumentIssueTarget(
  documentTypeCode: DocumentIssueDocumentType,
  target: PreparedDocumentIssueTarget,
  facts: DocumentIssueTargetFacts | undefined,
): bigint | null {
  if (facts === undefined)
    failTarget(target, ERROR_CODE.INVALID, "없는 발행 대상입니다.");
  if (
    facts.targetTypeCode !== target.targetTypeCode ||
    facts.targetId !== target.targetId
  )
    throw new Error("발행 대상 조회 결과가 요청과 일치하지 않습니다.");

  let sourceLotId: bigint | null = null;
  switch (documentTypeCode) {
    case "MATERIAL_LOT_LABEL":
      if (
        facts.targetTypeCode !== "LOT" ||
        facts.lotTypeCode !== "MATERIAL" ||
        !["INSPECTION_PENDING", "NORMAL"].includes(facts.statusCode)
      )
        failTarget(target, MATERIAL_LABEL_UNRESOLVED_STATE_POLICY);
      sourceLotId = facts.targetId;
      break;
    case "PRODUCTION_LOT_LABEL":
      if (
        facts.targetTypeCode !== "LOT" ||
        facts.lotTypeCode !== "PRODUCTION" ||
        facts.statusCode !== "NORMAL" ||
        facts.completedAt === null
      )
        failTarget(
          target,
          ERROR_CODE.STATE_LOCKED,
          "완료된 정상 생산 LOT만 발행할 수 있습니다.",
        );
      sourceLotId = facts.targetId;
      break;
    case "GOODS_ISSUE_QR":
      if (facts.targetTypeCode === "GOODS_ISSUE_LINE") {
        if (facts.goodsIssueStatusCode !== "POSTED")
          failTarget(
            target,
            ERROR_CODE.STATE_LOCKED,
            "전기된 출고 라인만 발행할 수 있습니다.",
          );
        sourceLotId = facts.lotId;
      } else if (facts.targetTypeCode === "HANDLING_UNIT") {
        if (facts.hasContent !== true)
          failTarget(
            target,
            ERROR_CODE.STATE_LOCKED,
            "내용물이 있는 포장만 출고 QR을 발행할 수 있습니다.",
          );
      }
      break;
    case "PACKING_LABEL":
      break;
    case "CERTIFICATE_OF_ANALYSIS":
      if (
        facts.targetTypeCode !== "INSPECTION_RESULT" ||
        facts.statusCode !== "CONFIRMED" ||
        facts.confirmedAt === null
      )
        failTarget(
          target,
          ERROR_CODE.STATE_LOCKED,
          "확정된 검사 결과만 성적서를 발행할 수 있습니다.",
        );
      sourceLotId = facts.lotId;
      break;
    case "IDENTIFICATION_TAG":
      return failTarget(target, IDENTIFICATION_LABEL_ELIGIBILITY_POLICY);
    case "TOOL_LABEL":
      break;
    case "LOCATION_LABEL":
      break;
    case "DELIVERY_LABEL":
      return failTarget(target, DELIVERY_ALLOCATION_TARGET_POLICY);
  }

  assertLotMatches(target, sourceLotId);
  return sourceLotId;
}

export function assertReissueReason(
  needsReason: boolean,
  reason: string | null | undefined,
  isActiveReason: boolean,
): string | null {
  if (reason === undefined || reason === null || reason.trim() === "") {
    if (needsReason)
      fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "reissueReasonCode",
        ERROR_CODE.REQUIRED,
        "재발행 사유가 필요합니다.",
      );
    if (reason !== undefined && reason !== null)
      fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "reissueReasonCode",
        ERROR_CODE.INVALID,
        "재발행 사유 코드가 올바르지 않습니다.",
      );
    return null;
  }
  if (!isActiveReason)
    fail(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "reissueReasonCode",
      ERROR_CODE.INVALID,
      "사용 가능한 재발행 사유가 아닙니다.",
    );
  return reason;
}

function assertSupportedPair(
  documentTypeCode: DocumentIssueDocumentType,
  targetTypeCode: DocumentTargetType,
  index: number,
): void {
  const supported: Partial<
    Record<DocumentIssueDocumentType, readonly DocumentTargetType[]>
  > = {
    MATERIAL_LOT_LABEL: ["LOT"],
    GOODS_ISSUE_QR: ["GOODS_ISSUE_LINE", "HANDLING_UNIT"],
    PRODUCTION_LOT_LABEL: ["LOT"],
    IDENTIFICATION_TAG: ["SERIAL_NUMBER"],
    PACKING_LABEL: ["HANDLING_UNIT"],
    CERTIFICATE_OF_ANALYSIS: ["INSPECTION_RESULT"],
    TOOL_LABEL: ["MOLD"],
    LOCATION_LABEL: ["LOCATION"],
  };
  if (!(supported[documentTypeCode] ?? []).includes(targetTypeCode))
    fail(
      HttpStatus.UNPROCESSABLE_ENTITY,
      `targets[${index}].targetTypeCode`,
      ERROR_CODE.INVALID,
      documentTypeCode === "DELIVERY_LABEL"
        ? "납품 라벨의 대상 유형이 계약에 없습니다."
        : "출력물 종류와 대상 유형이 맞지 않습니다.",
    );
}

function assertLotMatches(
  target: PreparedDocumentIssueTarget,
  sourceLotId: bigint | null,
): void {
  if (target.requestedLotId !== null && target.requestedLotId !== sourceLotId)
    fail(
      HttpStatus.UNPROCESSABLE_ENTITY,
      `targets[${target.index}].lotId`,
      ERROR_CODE.PAIR,
      "대상에 귀속된 LOT과 일치해야 합니다.",
    );
}

function assertSafeId(value: number, name: string): void {
  if (!Number.isSafeInteger(value))
    fail(
      HttpStatus.BAD_REQUEST,
      name,
      ERROR_CODE.RANGE,
      "안전한 정수 ID여야 합니다.",
    );
}

function failTarget(
  target: PreparedDocumentIssueTarget,
  policy: { code: string; message: string },
): never;
function failTarget(
  target: PreparedDocumentIssueTarget,
  code: string,
  message: string,
): never;
function failTarget(
  target: PreparedDocumentIssueTarget,
  codeOrPolicy: string | { code: string; message: string },
  message?: string,
): never {
  const code =
    typeof codeOrPolicy === "string" ? codeOrPolicy : codeOrPolicy.code;
  return fail(
    HttpStatus.UNPROCESSABLE_ENTITY,
    `targets[${target.index}].targetId`,
    code,
    typeof codeOrPolicy === "string" ? String(message) : codeOrPolicy.message,
  );
}

function fail(
  status: number,
  name: string,
  code: string,
  message: string,
): never {
  throw new ContractException(status, [field(name, code, message)]);
}
