import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { day } from '../../common/master';

/**
 * LOT 등록의 «규칙» — 번호 출처의 짝, 중복의 성격, 질의 조건.
 *
 * ⭐ 이 파일의 핵심은 **두 중복이 서로 다른 실패**라는 것이다. 스캔값 중복은 사람이
 * 고쳐야 풀리고(400), 서버 채번 충돌은 사용자가 고칠 수 없다(409). 계약이 그 이유까지
 * 적어 두었고, 판정이 흐려지면 화면이 「다시 눌러도 되는지」를 못 정한다.
 */

export type NumberSource = 'SUPPLIER' | 'MES';

export interface NumberSourceInput {
  numberSourceCode?: string;
  lotNo?: string;
}

/**
 * 번호 출처와 `lotNo` 의 짝. 계약이 400 설명에 조합을 못 박았다 —
 * 「SUPPLIER 인데 lotNo 가 없거나, MES 인데 lotNo 를 보냈다」.
 */
export function assertNumberSource(input: NumberSourceInput): NumberSource {
  const source = input.numberSourceCode;
  if (source !== 'SUPPLIER' && source !== 'MES') {
    throw one(field('numberSourceCode', ERROR_CODE.INVALID, 'SUPPLIER · MES 중 하나입니다.'));
  }
  const given = input.lotNo !== undefined && input.lotNo !== '';
  if (source === 'SUPPLIER' && !given) {
    throw one(field('lotNo', ERROR_CODE.REQUIRED, '사전부착은 스캔한 번호가 필요합니다.'));
  }
  if (source === 'MES' && given) {
    throw one(field('lotNo', ERROR_CODE.INVALID, '미부착은 서버가 번호를 매깁니다.'));
  }
  if (source === 'SUPPLIER' && (input.lotNo as string).length > 100) {
    throw one(field('lotNo', ERROR_CODE.RANGE, 'LOT 번호는 100자 이하입니다.'));
  }
  return source;
}

/** `uq_lot(plant_id, lot_no)` 위반인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다. */
export function isDuplicateLotNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.includes('lot_no');
}

export function duplicateLotNo(): ContractException {
  return one({
    scope: 'field',
    field: 'lotNo',
    code: ERROR_CODE.UNIQUE_VIOLATION,
    uniqueScope: ['plantId', 'lotNo'],
    message: '같은 공장에 이미 있는 LOT 번호입니다.',
  });
}

export function expiryWhere(from: string | undefined, to: string | undefined): Prisma.lotWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    expiry_date: {
      ...(from === undefined ? {} : { gte: day('expiryDateFrom', from) }),
      ...(to === undefined ? {} : { lte: day('expiryDateTo', to) }),
    },
  };
}

/** 「이 W/O 를 원천으로 발행된 LOT 만」 — 원천은 유형과 id 가 «짝»이다. */
export function workOrderWhere(workOrderId: number | undefined): Prisma.lotWhereInput {
  return workOrderId === undefined ? {} : { source_type_code: 'WORK_ORDER', source_id: workOrderId };
}

/** 「false 면 completedAt 이 비어 있는 것만, true 면 값이 있는 것만」(계약). */
export function completedWhere(completed: boolean | undefined): Prisma.lotWhereInput {
  if (completed === undefined) return {};
  return { completed_at: completed ? { not: null } : null };
}

/** 형식만 본다 — 값을 담을 칸이 없어 저장하지 않는 자리에 쓴다(§Z-4). */
export function assertDay(name: string, value: string, errors: ErrorItem[]): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    errors.push(field(name, ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
  }
}

export function assertInstant(name: string, value: string, errors: ErrorItem[]): void {
  if (Number.isNaN(Date.parse(value))) {
    errors.push(field(name, ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
}

export function optional<T>(column: string, value: T | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [column]: value };
}

export function bool(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

export function loose(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 숫자 축 — 글자가 섞이면 400 이다(그냥 넘기면 Prisma 검증 오류가 500 으로 샌다). */
export function assertId(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자 식별자여야 합니다.'));
}
