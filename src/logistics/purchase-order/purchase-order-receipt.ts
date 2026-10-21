import { Prisma } from '@prisma/client';

import { localToday } from '../../app/dashboard/dashboard-scope';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * P/O 입하 진행 — 입하 예정 화면(W-01-09)의 두 표가 같은 기준을 쓴다.
 * 왼쪽 P/O 목록(`purchase-order-query.service.ts`)과 오른쪽 라인 목록(`purchase-order-line-list.service.ts`).
 */

/** 발주가 끝난 헤더 상태 — 「남은 것만」에서 뺀다. */
export const CLOSED_ORDER_STATUSES = ['CLOSED', 'CANCELLED'];

/**
 * 입하 진행 — 서버가 판정해 화면이 규칙을 복사하지 않게 한다.
 * 「다 들어왔다」는 받은 수량이 발주 수량에 닿았을 때다. 부족 허용치(`tolerance_under_qty`)는 빼지 않는다 —
 * 발주 목록 `openOnly` 와 같은 기준이다(I-2.md §6-4).
 */
export type ReceiptStatusCode = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED' | 'CANCELLED';

interface LineQty {
  ordered_qty: Prisma.Decimal;
  received_qty: Prisma.Decimal;
  cancelled_at: Date | null;
}

export function lineReceiptStatus(line: LineQty, orderStatusCode: string): ReceiptStatusCode {
  // 헤더 취소는 MES 취소 · ERP 가 라인을 모두 취소한 경우다 — 어느 쪽이든 더 들어올 것이 없다.
  if (line.cancelled_at !== null || orderStatusCode === 'CANCELLED') return 'CANCELLED';
  if (line.received_qty.greaterThanOrEqualTo(line.ordered_qty)) return 'COMPLETED';
  return line.received_qty.greaterThan(0) ? 'PARTIAL' : 'NOT_STARTED';
}

/** 발주 − 누적 입하(0 아래는 0). 취소된 라인은 더 들어올 것이 없어 0 이다. */
export function remainingQtyOf(line: LineQty, orderStatusCode: string): Prisma.Decimal {
  const remaining = line.ordered_qty.minus(line.received_qty);
  return lineReceiptStatus(line, orderStatusCode) === 'CANCELLED' || remaining.lessThan(0)
    ? new Prisma.Decimal(0)
    : remaining;
}

export interface OrderReceiptSummary {
  lineCount: number;
  openLineCount: number;
  uomId: number | null;
  uomCode: string | null;
  orderedQtyTotal: number | null;
  receivedQtyTotal: number | null;
  remainingQtyTotal: number | null;
  receiptStatusCode: ReceiptStatusCode;
}

type SummaryLine = LineQty & { uom_id: bigint; uom: { uom_code: string } };

/**
 * P/O 한 건의 라인 묶음 값. 합계는 취소되지 않은 라인만 더한다.
 * ⭐ 그 라인들의 단위가 둘 이상이면 합계·단위를 모두 비운다(사용자 결정 2026-10-20) — kg 과 EA 를 더한 숫자는 뜻이 없다.
 */
export function orderReceiptSummary(orderStatusCode: string, lines: readonly SummaryLine[]): OrderReceiptSummary {
  const live = lines.filter((line) => line.cancelled_at === null);
  const statuses = live.map((line) => lineReceiptStatus(line, orderStatusCode));
  const units = new Set(live.map((line) => line.uom_id));
  const single = units.size === 1 ? live[0] : null;
  const sum = (pick: (line: SummaryLine) => Prisma.Decimal): number | null =>
    single === null ? null : Number(live.reduce((total, line) => total.plus(pick(line)), new Prisma.Decimal(0)));

  return {
    lineCount: lines.length,
    openLineCount: statuses.filter((status) => status === 'NOT_STARTED' || status === 'PARTIAL').length,
    uomId: single === null ? null : Number(single.uom_id),
    uomCode: single?.uom.uom_code ?? null,
    orderedQtyTotal: sum((line) => line.ordered_qty),
    receivedQtyTotal: sum((line) => line.received_qty),
    remainingQtyTotal: sum((line) => remainingQtyOf(line, orderStatusCode)),
    receiptStatusCode: orderStatus(orderStatusCode, lines.length, statuses),
  };
}

function orderStatus(orderStatusCode: string, lineCount: number, live: ReceiptStatusCode[]): ReceiptStatusCode {
  if (orderStatusCode === 'CANCELLED' || (lineCount > 0 && live.length === 0)) return 'CANCELLED';
  if (live.length > 0 && live.every((status) => status === 'COMPLETED')) return 'COMPLETED';
  if (live.some((status) => status !== 'NOT_STARTED')) return 'PARTIAL';
  return 'NOT_STARTED';
}

/** 남은 라인 — 취소되지 않았고 받은 수량이 발주 수량에 못 미친다. 같은 표 두 컬럼 비교는 Prisma `fields` 참조로 접는다. */
export function openLineWhere(prisma: PrismaService): Prisma.purchase_order_lineWhereInput {
  return { cancelled_at: null, received_qty: { lt: prisma.purchase_order_line.fields.ordered_qty } };
}

/** `expected_receipt_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 그대로 비교한다(CLAUDE.md). */
export function expectedDateWhere(from?: string, to?: string): Prisma.purchase_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    expected_receipt_date: {
      ...(from === undefined ? {} : { gte: dateOnly(from) }),
      ...(to === undefined ? {} : { lte: dateOnly(to) }),
    },
  };
}

/**
 * 「납기가 지났다」 = 납기 < 그 공장의 현지 오늘. 공장마다 시간대가 달라 공장별 헤더 조건을 OR 로 묶는다.
 * 공장이 하나도 없으면 빈 OR 이라 아무것도 걸리지 않는다.
 */
export async function overdueOrderWhere(
  prisma: PrismaService,
  plantId: number | bigint | undefined,
  now: Date,
): Promise<Prisma.purchase_orderWhereInput[]> {
  const plants = await prisma.plant.findMany({
    where: plantId === undefined ? {} : { plant_id: plantId },
    select: { plant_id: true, timezone_code: true },
  });
  return plants.map((plant) => ({
    plant_id: plant.plant_id,
    expected_receipt_date: { lt: dateOnly(localToday(now, plant.timezone_code)) },
  }));
}

export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
