import { PageRequest, pageRequest } from '../../common/pagination';

/** 계약이 조회 전용 마스터 7종에 똑같이 선언한 질의 축. */
export interface ReferenceQuery {
  q?: string;
  includeInactive?: boolean;
  page?: number;
  size?: number;
}

/**
 * `q` 는 「코드·명칭 검색」이다(계약). 두 칸을 대소문자 없이 부분 일치로 본다.
 * `includeInactive` 가 없으면 **쓰는 것만** 준다 — 마스터 목록의 기본 뜻이다.
 */
export function referenceWhere(
  query: ReferenceQuery,
  columns: { code: string; name: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const where: Record<string, unknown> = { ...extra };
  if (!query.includeInactive) where.is_active = true;
  if (query.q) {
    where.OR = [
      { [columns.code]: { contains: query.q, mode: 'insensitive' } },
      { [columns.name]: { contains: query.q, mode: 'insensitive' } },
    ];
  }
  return where;
}

export function referencePage(query: ReferenceQuery): PageRequest {
  return pageRequest(query);
}

/** `undefined` 인 필터는 조건에서 뺀다 — Prisma 는 `undefined` 를 「무시」로 읽지만 명시로 둔다. */
export function filter(field: string, value: number | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [field]: value };
}
