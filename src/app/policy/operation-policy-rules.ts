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
  'WEEKLY_WORKING_DAYS',
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
  WEEKLY_WORKING_DAYS: 'numeric',
};

/** 통제 수준 두 코드가 함께 쓰는 값 — 계약이 셋으로 닫았다. */
const CONTROL_LEVELS = ['BLOCK', 'WARN', 'OFF'];
const CONTROL_LEVEL_CODES: PolicyCode[] = ['PRECHECK_CONTROL_LEVEL', 'FIFO_ENFORCEMENT_LEVEL'];

/** 주간 근무일 — 5 = 월~금, 6 = 월~토(피처 003). */
export const WEEKLY_WORKING_DAYS = [5, 6] as const;
export type WeeklyWorkingDays = (typeof WEEKLY_WORKING_DAYS)[number];

/** 범위를 공장으로 못 박은 코드 — 다른 축으로 걸면 「어느 공장의 근무일인가」가 흐려진다. */
const PLANT_ONLY_CODES: PolicyCode[] = ['WEEKLY_WORKING_DAYS'];

/**
 * `W-05-01`(운영 정책) 밖에서 그 코드 «하나만» 읽고 쓰는 화면. 그 화면 권한으로는 다른 코드를 못 쓴다 —
 * 게이트는 오퍼레이션 단위라 코드까지는 못 가른다.
 */
const CODE_SCREENS: Partial<Record<PolicyCode, string>> = { WEEKLY_WORKING_DAYS: 'W-CO-15' };
const POLICY_SCREEN = 'W-05-01';

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
    code === 'WEEKLY_WORKING_DAYS' &&
    filled.numeric !== null &&
    !(WEEKLY_WORKING_DAYS as readonly number[]).includes(filled.numeric)
  ) {
    errors.push({
      scope: 'field',
      field: 'valueNumeric',
      code: ERROR_CODE.RANGE,
      message: `주간 근무일은 ${WEEKLY_WORKING_DAYS.join(' · ')} 중 하나입니다.`,
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

/** 공장 전용 코드는 공장을 주고 품목·공정을 비운다. 사업부는 공장에 딸려 오므로 함께 있어도 공장 범위다. */
export function assertScope(code: PolicyCode, scope: PolicyScope): void {
  if (!PLANT_ONLY_CODES.includes(code)) return;
  const errors: ErrorItem[] = [];
  if (scope.plantId == null) {
    errors.push({ scope: 'field', field: 'plantId', code: ERROR_CODE.REQUIRED, message: `${code} 는 공장마다 정합니다.` });
  }
  for (const axis of ['itemId', 'processId'] as const) {
    if (scope[axis] != null) {
      errors.push({ scope: 'field', field: axis, code: ERROR_CODE.INVALID, message: `${code} 는 공장 범위만 받습니다.` });
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** 운영 정책 화면 권한이 없으면 그 코드 전용 화면 권한이 있어야 읽고 쓴다. */
export function assertWritable(code: PolicyCode, permissions: readonly string[]): void {
  const screen = CODE_SCREENS[code];
  if (permissions.includes(POLICY_SCREEN) || (screen !== undefined && permissions.includes(screen))) return;
  throw new ContractException(HttpStatus.FORBIDDEN, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '이 정책 코드를 볼 권한이 없습니다.' },
  ]);
}

/**
 * 목록에서 볼 수 있는 코드. `W-05-01` 이 있거나 코드 전용 화면 권한이 하나도 없으면 거르지 않는다(지금과 같다 —
 * 목록은 권한을 보지 않는 경로다). 코드 전용 화면 권한만 있으면 그 코드들만 본다.
 */
export function readableCodes(permissions: readonly string[]): PolicyCode[] | null {
  if (permissions.includes(POLICY_SCREEN)) return null;
  const codes = (Object.entries(CODE_SCREENS) as [PolicyCode, string][])
    .filter(([, screen]) => permissions.includes(screen))
    .map(([code]) => code);
  return codes.length === 0 ? null : codes;
}

/**
 * 맞는 정책 가운데 이기는 하나. 좁은 축이 이기고, 같으면 늦게 시작한 것 → 나중에 만든 것 순이다.
 * 겹치는 정책을 물리가 막지 않으므로 «결정적으로» 고르는 것이 서버 몫이다.
 */
export function winnerOf(rows: PolicyRow[]): PolicyRow | undefined {
  return [...rows].sort(
    (a, b) =>
      scopeRank(a) - scopeRank(b) ||
      b.effective_from.getTime() - a.effective_from.getTime() ||
      Number(b.operation_policy_id - a.operation_policy_id),
  )[0];
}

function fieldOf(slot: 'text' | 'numeric' | 'boolean'): string {
  return `value${slot[0].toUpperCase()}${slot.slice(1)}`;
}
