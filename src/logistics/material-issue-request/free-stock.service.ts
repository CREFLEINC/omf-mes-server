import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { freeQty, pairKey } from '../../core/material-issue/planned-stock';
import { PrismaService } from '../../prisma/prisma.service';

export interface FreeStockQuery {
  warehouseIds?: unknown;
  itemIds?: unknown;
}

export interface FreeStockRow {
  warehouseId: number;
  itemId: number;
  availableQty: number;
  plannedQty: number;
  freeQty: number;
}

const ZERO = new Prisma.Decimal(0);

/**
 * 창고·품목별 쓸 수 있는 양(W-02-10 남은 수량 · omf-all-around#232).
 *
 * 쓸 수 있는 양 = 집을 수 있는 가용 − 다른 요청의 출고 예정(0 미만은 0). 출발 창고 선택·새 요청 상한과 같은 식
 * (`core/material-issue/planned-stock.ts` freeQty)이라 화면 값과 발행 결과가 어긋나지 않는다.
 * 출고 예정 재고 조회(`planned-stock`)는 예정이 잡힌 쌍만 다루므로 남은 수량에 쓰지 않는다 — 예정이 없는
 * 자재가 빠져 「재고 있는 생산 창고 없음」으로 보였다. 가용도 예정도 없는 쌍은 싣지 않는다.
 */
@Injectable()
export class FreeStockService {
  constructor(private readonly prisma: PrismaService) {}

  async query(query: FreeStockQuery): Promise<{ items: FreeStockRow[] }> {
    const warehouseIds = ids(query.warehouseIds, 'warehouseIds');
    const itemIds = ids(query.itemIds, 'itemIds');
    const { available, planned } = await freeQty(this.prisma, warehouseIds, itemIds);
    const items: FreeStockRow[] = [];
    for (const warehouseId of warehouseIds) {
      for (const itemId of itemIds) {
        const key = pairKey(warehouseId, itemId);
        const avail = available.get(key) ?? ZERO;
        const plan = planned.get(key) ?? ZERO;
        if (avail.isZero() && plan.isZero()) continue;
        items.push({
          warehouseId: Number(warehouseId),
          itemId: Number(itemId),
          availableQty: avail.toNumber(),
          plannedQty: plan.toNumber(),
          freeQty: Prisma.Decimal.max(avail.minus(plan), ZERO).toNumber(),
        });
      }
    }
    return { items };
  }
}

/** 쉼표 목록(`?warehouseIds=1,2` · 계약 explode=false) 또는 반복 쿼리 → 중복 없는 양의 정수. */
function ids(value: unknown, name: string): bigint[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const parsed = raw.map((v) => String(v).trim()).filter((v) => v !== '');
  if (parsed.length === 0 || parsed.some((v) => !/^[1-9]\d*$/.test(v))) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field(name, ERROR_CODE.INVALID, '양의 정수 번호를 하나 이상 줍니다.')]);
  }
  return [...new Set(parsed)].map((v) => BigInt(v));
}
