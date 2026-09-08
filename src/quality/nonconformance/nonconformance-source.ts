import { Prisma } from '@prisma/client';

/**
 * `sourceCode` — 부적합 원천(제품 OQC 불합격 `PRODUCT` · 반품 `RETURN`). 물리에 칸이 없다 —
 * 계약이 「서버가 대상 LOT 의 «입고 유형»으로 파생한다」라 직접 적었다(§1-4-1). 대상 LOT 이
 * 여럿이면 **하나라도 반품이면 RETURN**(통보 대상 — 흔적만 남긴다).
 *
 * ⭐ 목록 «질의»(`sourceCode=` 필터)와 «응답»(각 행의 `sourceCode`) 이 같은 EXISTS 식을 써야
 * 한다(§4-2 — 한 곳에 둔다) — 이 파일이 그 «사용처 2»다.
 */
export type SourceCode = 'PRODUCT' | 'RETURN';

/** LOT 이 반품 입고로 들어왔는지 — 질의 필터와 응답 계산이 공유하는 조건. */
const RETURN_RECEIPT_LOT_WHERE: Prisma.lotWhereInput = {
  goods_receipt_line: { some: { goods_receipt: { receipt_type_code: 'RETURN' } } },
};

/**
 * 질의 필터 — `sourceCode=RETURN` 은 대상 LOT 중 하나라도 반품이면 집고,
 * `sourceCode=PRODUCT` 는 전부 아니어야 집는다(대칭 — 「반증」이 아니라 여집합).
 */
export function nonconformanceSourceWhere(sourceCode: SourceCode): Prisma.nonconformanceWhereInput {
  return {
    nonconformance_lot: {
      [sourceCode === 'RETURN' ? 'some' : 'none']: { lot: RETURN_RECEIPT_LOT_WHERE },
    },
  };
}

/**
 * 응답 계산에 쓰는 최소 select — `lots[]` 조인(`nonconformance_lot.lot`)에 얹어 추가 질의
 * 0으로 존재 여부만 확인한다(`take: 1` — 몇 건인지는 안 본다).
 */
export const SOURCE_LOT_SELECT = {
  goods_receipt_line: {
    where: { goods_receipt: { receipt_type_code: 'RETURN' } },
    select: { goods_receipt_line_id: true },
    take: 1,
  },
} satisfies Prisma.lotSelect;

/** 위 `SOURCE_LOT_SELECT` 로 실어 온 행에서 `sourceCode` 를 계산한다. */
export function sourceCodeOf(lots: ReadonlyArray<{ lot: { goods_receipt_line: unknown[] } }>): SourceCode {
  return lots.some((row) => row.lot.goods_receipt_line.length > 0) ? 'RETURN' : 'PRODUCT';
}
