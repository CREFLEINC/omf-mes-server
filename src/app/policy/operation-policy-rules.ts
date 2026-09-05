import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';

/**
 * 운영 정책의 «규칙» 둘 — 코드마다 쓰는 값 칸, 그리고 범위 우선순위.
 *
 * ⭐ 이 파일이 정책의 뜻을 담는다. 서비스는 이 규칙을 질의와 저장에 잇기만 한다.
 */

/** 계약이 `policyCode` 를 enum 으로 닫았다 — 고객이 늘리는 값이 아니다. */
export const POLICY_CODES = [
  'SHOT_CONVERSION_ENABLED',
  'SHOT_CONVERSION_RATIO',
  'MINOR_STOP_THRESHOLD_MINUTES',
  'PRECHECK_CONTROL_LEVEL',
  'FIFO_ENFORCEMENT_LEVEL',
] as const;
export type PolicyCode = (typeof POLICY_CODES)[number];

/**
 * 코드마다 «쓰는 값 칸»이 다르다 — 계약이 `policyCode` 설명에 코드별로 못 박았다.
 * ⛔ 강제하지 않으면 빈 칸을 든 정책이 저장되고, 화면은 그 빈 칸을 읽는다.
 */
const VALUE_SLOT: Record<PolicyCode, 'boolean' | 'numeric' | 'text'> = {
  SHOT_CONVERSION_ENABLED: 'boolean',
  SHOT_CONVERSION_RATIO: 'numeric',
  MINOR_STOP_THRESHOLD_MINUTES: 'numeric',
  PRECHECK_CONTROL_LEVEL: 'text',
  FIFO_ENFORCEMENT_LEVEL: 'text',
};

/** 통제 수준 두 코드가 함께 쓰는 값 — 계약이 셋으로 닫았다. */
const CONTROL_LEVELS = ['BLOCK', 'WARN', 'OFF'];
const CONTROL_LEVEL_CODES: PolicyCode[] = ['PRECHECK_CONTROL_LEVEL', 'FIFO_ENFORCEMENT_LEVEL'];

/**
 * 좁은 범위가 이긴다. ⛔ 이 «순서»가 곧 정책 우선순위다 — 계약이 값을 닫아 두었고,
 * 값이 늘면 판정 순서가 함께 늘어야 한다.
 */
export const SCOPES = [
  { code: 'ITEM', column: 'item_id' },
  { code: 'PROCESS', column: 'process_id' },
  { code: 'PLANT', column: 'plant_id' },
  { code: 'BUSINESS_UNIT', column: 'business_unit_id' },
] as const;
export type MatchedScope = (typeof SCOPES)[number]['code'] | 'ALL';

export interface PolicyScope {
  businessUnitId?: number | null;
  plantId?: number | null;
  itemId?: number | null;
  processId?: number | null;
}

export interface PolicyValues {
  valueText?: string | null;
  valueNumeric?: number | null;
  valueBoolean?: boolean | null;
}

/** 계약 `OperationPolicyEffective`. `resolved` 가 거짓이면 값이 전부 비어 있다. */
export interface EffectiveView {
  policyCode: string;
  resolved: boolean;
  operationPolicyId: number | null;
  valueText: string | null;
  valueNumeric: number | null;
  valueBoolean: boolean | null;
  /**
   * ⛔ 맞는 정책이 없으면 **칸째 뺀다.** 계약 설명은 「resolved 가 거짓이면 비어 있다」
   * 인데 스키마가 `enum` 에 `null` 을 안 넣어 `null` 이 계약 스스로를 통과하지 못한다.
   * 툴의 `pmDueAxisCode` 와 같은 자리고, 전 계약에 같은 모양이 16곳이다(되돌림 §Y-1).
   */
  matchedScopeCode?: MatchedScope;
}

type PolicyRow = Prisma.operation_policyGetPayload<object>;

/**
 * 질의가 그 축을 주었을 때만 「그 값과 같은 정책」도 후보에 넣는다.
 * 축이 빈 정책은 「지정 없음」이라 어느 값에도 맞지만, 질의가 축을 안 주면 그 축을
 * «지정한» 정책은 맞지 않는다 — 무엇에 적용할지 알 수 없기 때문이다.
 */
export function axisCandidates(column: string, scope: PolicyScope): Record<string, number>[] {
  const value = {
    item_id: scope.itemId,
    process_id: scope.processId,
    plant_id: scope.plantId,
    business_unit_id: scope.businessUnitId,
  }[column];
  return value == null ? [] : [{ [column]: value }];
}

/** 이긴 정책이 «어느 축»으로 맞았는가 — 가장 좁은 축이 그 정책의 범위다. */
export function scopeOf(row: PolicyRow): MatchedScope {
  for (const { code, column } of SCOPES) {
    if (row[column as keyof PolicyRow] !== null) return code;
  }
  return 'ALL';
}

/** 좁을수록 작은 수 — 정렬에 그대로 쓴다. */
export function scopeRank(row: PolicyRow): number {
  const index = SCOPES.findIndex(({ column }) => row[column as keyof PolicyRow] !== null);
  return index === -1 ? SCOPES.length : index;
}

export function unresolved(policyCode: PolicyCode): EffectiveView {
  return {
    policyCode,
    resolved: false,
    operationPolicyId: null,
    valueText: null,
    valueNumeric: null,
    valueBoolean: null,
  };
}

export function assertPolicyCode(value: string | undefined): PolicyCode {
  if (value !== undefined && (POLICY_CODES as readonly string[]).includes(value)) {
    return value as PolicyCode;
  }
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'field',
      field: 'policyCode',
      code: value === undefined ? ERROR_CODE.REQUIRED : ERROR_CODE.INVALID,
      message: `정책 코드는 ${POLICY_CODES.join(' · ')} 중 하나입니다.`,
    },
  ]);
}

/**
 * 코드가 요구하는 값 칸이 채워졌는지 본다. ⛔ 다른 칸을 함께 채우는 것도 막는다 —
 * 두 칸이 다른 말을 하면 어느 것이 정책인지 알 수 없다.
 */
export function assertValues(code: PolicyCode, input: PolicyValues): void {
  const slot = VALUE_SLOT[code];
  const filled = {
    text: input.valueText ?? null,
    numeric: input.valueNumeric ?? null,
    boolean: input.valueBoolean ?? null,
  };
  const errors: ErrorItem[] = [];

  if (filled[slot] === null) {
    errors.push({
      scope: 'field',
      field: fieldOf(slot),
      code: ERROR_CODE.REQUIRED,
      message: `${code} 는 이 칸으로 값을 정합니다.`,
    });
  }
  for (const other of ['text', 'numeric', 'boolean'] as const) {
    if (other !== slot && filled[other] !== null) {
      errors.push({
        scope: 'field',
        field: fieldOf(other),
        code: ERROR_CODE.INVALID,
        message: `${code} 가 쓰지 않는 칸입니다.`,
      });
    }
  }
  // 계약이 「0 보다 커야 한다」로 못 박은 자리다.
  if (code === 'SHOT_CONVERSION_RATIO' && filled.numeric !== null && filled.numeric <= 0) {
    errors.push({
      scope: 'field',
      field: 'valueNumeric',
      code: ERROR_CODE.RANGE,
      message: '환산 비율은 0 보다 커야 합니다.',
    });
  }
  if (
    CONTROL_LEVEL_CODES.includes(code) &&
    filled.text !== null &&
    !CONTROL_LEVELS.includes(filled.text)
  ) {
    errors.push({
      scope: 'field',
      field: 'valueText',
      code: ERROR_CODE.INVALID,
      message: `통제 수준은 ${CONTROL_LEVELS.join(' · ')} 중 하나입니다.`,
    });
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function fieldOf(slot: 'text' | 'numeric' | 'boolean'): string {
  return `value${slot[0].toUpperCase()}${slot.slice(1)}`;
}
