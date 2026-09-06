import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PageMeta, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

export interface ReservationQuery {
  itemId?: unknown;
  lotId?: unknown;
  warehouseId?: unknown;
  sourceDocumentId?: unknown;
  statusCode?: string;
  openOnly?: boolean | string;
  page?: unknown;
  size?: unknown;
}

/** 계약 `InventoryReservation` — required 12 + 널 허용 둘. */
export type InventoryReservationView = ReturnType<typeof reservationView>;

export interface ReservationResponse {
  items: InventoryReservationView[];
  page: PageMeta;
}

interface ReservationRow {
  inventory_reservation_id: bigint;
  reservation_no: string;
  reservation_type_code: string;
  source_document_type_code: string;
  source_document_id: bigint;
  item_id: bigint;
  lot_id: bigint | null;
  warehouse_id: bigint;
  location_id: bigint | null;
  reserved_qty: Prisma.Decimal;
  released_qty: Prisma.Decimal;
  consumed_qty: Prisma.Decimal;
  uom_id: bigint;
  status_code: string;
}

/**
 * `GET /inventory/reservations` — 재고 예약 목록. 계약이 조회만 연다(쓰기 경로 0건).
 *
 * ⚠ **오늘 언제나 빈 목록이다** — 예약을 «거는» 오퍼레이션이 계약에 없다(I-8.md §5 · 045).
 *   첫 사용처는 I-22(제품 피킹)다.
 * ⛔ 잔액 축의 곁에 둔다 — 오퍼레이션 하나에 디렉터리를 만들지 않는다(I-7 R-13 · §8-4).
 * ⛔ `statusCode` 는 문자 그대로 건다 — 값 목록을 세우지 않는 칸이라(`x-no-code-key`)
 *   대조를 걸면 값이 생길 때 조회가 400 을 낸다.
 */
@Injectable()
export class InventoryReservationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ReservationQuery): Promise<ReservationResponse> {
    const page = pageRequest({ page: int(query.page), size: int(query.size) });
    const where = reservationWhere(query);
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<ReservationRow[]>(Prisma.sql`
        SELECT inventory_reservation_id, reservation_no, reservation_type_code,
               source_document_type_code, source_document_id, item_id, lot_id, warehouse_id,
               location_id, reserved_qty, released_qty, consumed_qty, uom_id, status_code
          FROM inventory.inventory_reservation
         WHERE ${where}
         -- 계약 침묵 — PK 역순이다(§8-1 · PK 가 유일해 페이지 경계가 흔들리지 않는다).
         ORDER BY inventory_reservation_id DESC
         LIMIT ${page.take} OFFSET ${page.skip}`),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS total FROM inventory.inventory_reservation WHERE ${where}`),
    ]);
    return pagedResponse(rows.map(reservationView), Number(counted[0].total), page);
  }
}

/**
 * ⭐ `openOnly` 가 이 목록을 `$queryRaw` 로 만든 이유다 — 「아직 소진되지 않은 예약」은
 * 상태 문자열이 아니라 **수량 축**(`reserved − released − consumed > 0`)이고 칸끼리의
 * 뺄셈은 Prisma `where` 로 쓸 수 없다(§8-4). 값은 전부 파라미터로 나간다.
 */
export function reservationWhere(query: ReservationQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  const id = (column: string, value: unknown): void => {
    const parsed = int(value);
    if (parsed !== undefined) {
      conditions.push(Prisma.sql`${Prisma.raw(column)} = ${BigInt(parsed)}`);
    }
  };
  id('item_id', query.itemId);
  id('lot_id', query.lotId);
  id('warehouse_id', query.warehouseId);
  id('source_document_id', query.sourceDocumentId);
  if (query.statusCode !== undefined) {
    conditions.push(Prisma.sql`status_code = ${query.statusCode}`);
  }
  if (query.openOnly === true || query.openOnly === 'true') {
    conditions.push(Prisma.sql`reserved_qty - released_qty - consumed_qty > 0`);
  }
  return Prisma.join(conditions, ' AND ');
}

/** ⛔ 널 허용 칸(`lotId`·`locationId`)은 «키 생략»이 아니라 널이다(R-20). */
function reservationView(row: ReservationRow) {
  return {
    inventoryReservationId: Number(row.inventory_reservation_id),
    reservationNo: row.reservation_no,
    reservationTypeCode: row.reservation_type_code,
    sourceDocumentTypeCode: row.source_document_type_code,
    sourceDocumentId: Number(row.source_document_id),
    itemId: Number(row.item_id),
    lotId: row.lot_id === null ? null : Number(row.lot_id),
    warehouseId: Number(row.warehouse_id),
    locationId: row.location_id === null ? null : Number(row.location_id),
    reservedQty: Number(row.reserved_qty),
    releasedQty: Number(row.released_qty),
    consumedQty: Number(row.consumed_qty),
    uomId: Number(row.uom_id),
    statusCode: row.status_code,
  };
}

function int(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
