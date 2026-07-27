import { ConflictException, NotFoundException } from '@nestjs/common';

import { PageQueryDto } from '../../common/dto/page-query.dto';

/**
 * mdm 마스터들이 공유하는 골격.
 *
 * 정본 물리 모델의 마스터 테이블은 형태가 같다 —
 * 자연키(코드) + 명칭 + `is_active` + 감사 컬럼 + `version_no`.
 * 엔티티마다 되풀이되는 부분만 여기로 모으고, 각 서비스는 자기 스키마에 맞춰 사용한다.
 */

/** `contains` 부분일치 OR 조건. 필드가 비면 undefined를 돌려 where에 넣지 않게 한다. */
export function keywordFilter<T>(keyword: string | undefined, fields: string[]): T[] | undefined {
  if (!keyword) return undefined;
  return fields.map((field) => ({
    [field]: { contains: keyword, mode: 'insensitive' },
  })) as T[];
}

/** `is_active` 필터 + 키워드 OR을 합친 공통 where 조각. */
export function baseWhere<T extends Record<string, unknown>>(
  query: PageQueryDto,
  keywordFields: string[],
  extra?: T,
): Record<string, unknown> {
  const where: Record<string, unknown> = { ...(extra ?? {}) };
  if (query.isActive !== undefined) where.is_active = query.isActive;

  const or = keywordFilter(query.keyword, keywordFields);
  if (or) where.OR = or;

  return where;
}

/** 수정 시 공통으로 붙는 필드 — 감사 + 낙관적 락 컬럼 증가. */
export function updateStamp(actor?: bigint) {
  return { updated_by: actor, version_no: { increment: 1 } };
}

/** 등록 시 공통으로 붙는 감사 필드. */
export function createStamp(actor?: bigint) {
  return { created_by: actor, updated_by: actor };
}

/** 조회 결과가 없으면 404. */
export function orFail<T>(entity: T | null, label: string): T {
  if (!entity) throw new NotFoundException(`${label}을(를) 찾을 수 없습니다.`);
  return entity;
}

/** 이미 있으면 409. */
export function orConflict(exists: unknown, message: string): void {
  if (exists) throw new ConflictException(message);
}
