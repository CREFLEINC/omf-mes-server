import { ConflictException, NotFoundException } from '@nestjs/common';

import { BasePageQueryDto } from '../../common/dto/page-query.dto';

export function keywordFilter<T>(keyword: string | undefined, fields: string[]): T[] | undefined {
  if (!keyword) return undefined;
  return fields.map((field) => ({
    [field]: { contains: keyword, mode: 'insensitive' },
  })) as T[];
}

export function baseWhere<T extends Record<string, unknown>>(
  query: BasePageQueryDto & { isActive?: boolean },
  keywordFields: string[],
  extra?: T,
): Record<string, unknown> {
  const where: Record<string, unknown> = { ...(extra ?? {}) };
  if (query.isActive !== undefined) where.is_active = query.isActive;

  const or = keywordFilter(query.keyword, keywordFields);
  if (or) where.OR = or;

  return where;
}

export function updateStamp(actor?: bigint) {
  return { updated_by: actor, version_no: { increment: 1 } };
}

export function createStamp(actor?: bigint) {
  return { created_by: actor, updated_by: actor };
}

export function orFail<T>(entity: T | null, label: string): T {
  if (!entity) throw new NotFoundException(`${label}을(를) 찾을 수 없습니다.`);
  return entity;
}

export function orConflict(exists: unknown, message: string): void {
  if (exists) throw new ConflictException(message);
}

/**
 * 창고·생산라인·설비는 `(plant_id, *_code)`로만 유니크하다 — 전역 유니크가 아니다.
 * 단일 공장을 전제로 코드만 받되, 여러 공장에 같은 코드가 있으면
 * 조용히 첫 건을 고르지 않고 거부한다.
 */
export function exactlyOne<T>(rows: T[], label: string, code: string): T {
  if (rows.length === 0) {
    throw new NotFoundException(`${label}(${code})을(를) 찾을 수 없습니다.`);
  }
  if (rows.length > 1) {
    throw new ConflictException(
      `${label} 코드 ${code}가 여러 공장에 존재합니다. 공장을 함께 지정해 조회하십시오.`,
    );
  }
  return rows[0];
}
