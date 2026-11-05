import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { ContractException, ERROR_CODE } from '../../common/errors';
import type { MasterReason } from '../production-plan/master-choice';

/**
 * 계획 제안의 판정 — 구분·상태·사유 분류. 계산(`proposal-builder.ts`)과 확정(`proposal-confirm.service.ts`)이 이 한 벌을 쓴다.
 * 업무 결정이 바뀔 수 있는 자리는 함수 하나씩으로 모아 둔다: `plansToPropose`(작성중 계획이 있으면 남은 수량을 제안하는가),
 * `assertWholeOrder`(한 ERP W/O 안에서 일부 계획만 확정하는가).
 */

/** 계약 `ProductionPlanProposalReasonCode` — 응답은 이 순서로 낸다. */
export const PROPOSAL_REASONS = [
  'ORDER_CANCELLED',
  'BOM_DEFAULT_REQUIRED',
  'ROUTING_REQUIRED',
  'ROUTING_DEFAULT_REQUIRED',
  'ROUTING_OPERATION_REQUIRED',
  'WORK_ORDER_LINE_REQUIRED',
  'WORK_ORDER_LOCATION_REQUIRED',
  'LINE_PLANT_MISMATCH',
  'PLAN_QTY_EXCEEDS_ORDER',
] as const;
export type ProposalReasonCode = (typeof PROPOSAL_REASONS)[number];

/** 제안 불가 — 이 화면에서 풀 수 없다(기준정보·ERP W/O 상태). 나머지 BLOCK 은 화면에서 골라 풀린다. */
const BLOCKED_REASONS: ReadonlySet<ProposalReasonCode> = new Set([
  'ORDER_CANCELLED',
  'BOM_DEFAULT_REQUIRED',
  'ROUTING_REQUIRED',
  'ROUTING_DEFAULT_REQUIRED',
  'ROUTING_OPERATION_REQUIRED',
]);

export type ProposalCategory = 'INPUT' | 'BLOCKED';
export type ProposalKind = 'NEW_PLAN' | 'REVIEW_DRAFT' | 'KEEP_CONFIRMED' | 'NOT_PROPOSABLE';
export type ProposalStatus = 'CONFIRMABLE' | 'NEEDS_INPUT' | 'NO_CHANGE';

export interface ProposalIssue {
  severity: 'BLOCK' | 'WARN';
  category: ProposalCategory;
  code: string;
  field?: string;
  message: string;
}

export interface ProposalReason {
  code: ProposalReasonCode;
  category: ProposalCategory;
}

export const categoryOf = (code: ProposalReasonCode): ProposalCategory => (BLOCKED_REASONS.has(code) ? 'BLOCKED' : 'INPUT');

export function blockIssue(code: ProposalReasonCode, message: string, field?: string): ProposalIssue {
  return { severity: 'BLOCK', category: categoryOf(code), code, message, ...(field === undefined ? {} : { field }) };
}

/** 4M 점검(`validation.ts`)의 WARN — 확정을 막지 않는다. */
export function warnIssue(code: string, message: string, field: string): ProposalIssue {
  return { severity: 'WARN', category: 'INPUT', code, field, message };
}

const MASTER_MESSAGE: Record<MasterReason, string> = {
  BOM_DEFAULT_REQUIRED: '품목에 ERP 기본 BOM 이 하나로 정해져 있지 않습니다. 기준정보에서 기본 BOM 을 정하세요.',
  ROUTING_REQUIRED: '쓸 수 있는(확정·유효 기간 안) Routing 이 없습니다. 기준정보에서 공정을 등록하세요.',
  ROUTING_DEFAULT_REQUIRED: '쓸 수 있는 Routing 이 여럿인데 기본이 하나로 정해져 있지 않습니다. 기준정보에서 기본 공정을 정하세요.',
};
export const masterIssue = (reason: MasterReason): ProposalIssue => blockIssue(reason, MASTER_MESSAGE[reason]);

/**
 * 어떤 계획을 제안하는가. 작성중 계획이 있으면 그 계획들만 검토한다 — 남은 수량으로 새 계획을 더하지 않는다.
 * 없으면 확정 계획량을 뺀 수량으로 새 계획 하나.
 */
export function plansToPropose<T>(
  drafts: readonly T[],
  orderQty: Prisma.Decimal,
  confirmedQty: Prisma.Decimal,
): { kind: 'REVIEW_DRAFT'; drafts: readonly T[] } | { kind: 'NEW_PLAN'; qty: Prisma.Decimal } {
  if (drafts.length > 0) return { kind: 'REVIEW_DRAFT', drafts };
  return { kind: 'NEW_PLAN', qty: orderQty.minus(confirmedQty) };
}

/** 사유 — BLOCK 문제의 코드를 한 번씩, `PROPOSAL_REASONS` 순서로. */
export function reasonsOf(issues: readonly ProposalIssue[]): ProposalReason[] {
  const codes = new Set(issues.filter((issue) => issue.severity === 'BLOCK').map((issue) => issue.code));
  return PROPOSAL_REASONS.filter((code) => codes.has(code)).map((code) => ({ code, category: categoryOf(code) }));
}

export function statusOf(kind: ProposalKind, cancelled: boolean, reasons: readonly ProposalReason[]): ProposalStatus {
  if (kind === 'KEEP_CONFIRMED' || cancelled) return 'NO_CHANGE';
  return reasons.length > 0 ? 'NEEDS_INPUT' : 'CONFIRMABLE';
}

/** 계획일 — ERP 계획 시작일이 공장 현지 오늘 이후면 그날, 없거나 지났으면 오늘. `YYYY-MM-DD` 라 문자열 비교가 날짜 비교다. */
export function proposedPlanDate(plannedStartDate: string | null, today: string): string {
  return plannedStartDate !== null && plannedStartDate >= today ? plannedStartDate : today;
}

/** 새 계획은 `new-1`…, 작성중 계획은 `plan-{id}` — 저장된 번호·id 와 섞이지 않는 임시 식별자. */
export const newPlanKey = (index: number): string => `new-${index + 1}`;
export const draftPlanKey = (productionPlanId: bigint): string => `plan-${String(productionPlanId)}`;

/**
 * 한 ERP W/O 는 제안한 계획을 전부 확정하거나 아무것도 하지 않는다 — 본문의 계획 집합이 제안과 다르면 400.
 * 일부만 확정하게 바꾸려면 이 함수를 고친다.
 */
export function assertWholeOrder(proposedKeys: readonly string[], bodyKeys: readonly string[]): void {
  const proposed = [...proposedKeys].sort();
  const sent = [...bodyKeys].sort();
  if (proposed.length === sent.length && proposed.every((key, index) => key === sent[index])) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [{
    scope: 'field',
    field: 'plans',
    code: ERROR_CODE.INVALID,
    message: proposed.length === 0
      ? '이 ERP W/O 는 확정할 계획 제안이 없습니다. 제안을 다시 조회하세요.'
      : `제안한 계획(${proposed.join(', ')})을 모두 실어 보내야 합니다 — 한 ERP W/O 는 전부 확정하거나 아무것도 하지 않습니다.`,
  }]);
}

/** 변경 감지 값 — 기준의 «내용»을 해시한다(판을 올리지 않는 기준정보도 잡는다). 불투명 문자열이라 화면은 비교만 한다. */
export function basisHash(value: unknown): string {
  const json = JSON.stringify(value, (_, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Prisma.Decimal) return item.toString();
    return item;
  });
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}
