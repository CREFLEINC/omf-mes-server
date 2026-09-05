import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { toDateString } from '../../common/master';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 수불 이력 — **재고 원장을 밖에서 보는 유일한 창**이다.
 *
 * `InventoryPostingService` 가 남긴 것을 그대로 읽는다. 이 경로가 서기 전까지 원장은
 * 엔진 안에서만 참이었고 계약 경로로는 확인할 길이 없었다.
 *
 * ⛔ 이 서비스는 **읽기 전용**이다. 원장은 append-only 이고 정정은 역트랜잭션이다 —
 * 조회에서 손대는 것이 없다(결정 08 · 트리거가 UPDATE·DELETE 를 막는다).
 */

/** 계약이 `sourceDocumentTypeCode` 를 enum 으로 닫았다 — 네 값뿐이다. */
type SourceDocumentType = 'GOODS_RECEIPT' | 'GOODS_ISSUE' | 'INVENTORY_ADJUSTMENT' | 'STOCK_TRANSFER';

export interface TransactionQuery {
  businessDateFrom?: string;
  businessDateTo?: string;
  itemId?: number;
  lotId?: number;
  warehouseId?: number;
  locationId?: number;
  transactionTypeCode?: string;
  sourceDocumentTypeCode?: SourceDocumentType;
  page?: number;
  size?: number;
}

/** 계약 `InventoryTransaction` 과 동형. */
interface TransactionView {
  inventoryTransactionId: number;
  businessDate: string;
  transactionNo: string;
  transactionTypeCode: string;
  plantId: number;
  occurredAt: string;
  recordedAt: string;
  sourceDocumentTypeCode: string;
  sourceDocumentId: number;
  statusCode: string;
  reversalOfTransactionId: number | null;
  reversalOfBusinessDate: string | null;
}

/** 계약 `InventoryTransactionLine` 과 동형. */
interface TransactionLineView {
  inventoryTransactionLineId: number;
  inventoryTransactionId: number;
  businessDate: string;
  lineNo: number;
  itemId: number;
  lotId: number | null;
  qty: number;
  uomId: number;
  fromWarehouseId: number | null;
  fromLocationId: number | null;
  fromQualityStatusCode: string | null;
  fromInventoryStatusCode: string | null;
  toWarehouseId: number | null;
  toLocationId: number | null;
  toQualityStatusCode: string | null;
  toInventoryStatusCode: string | null;
  ownershipTypeCode: string;
  ownerPartnerId: number | null;
  handlingUnitId: number | null;
  fromQtyAfterTransaction: number | null;
  toQtyAfterTransaction: number | null;
}

export interface TransactionDetail {
  inventoryTransaction: TransactionView;
  lines: TransactionLineView[];
}

type TransactionRow = Prisma.inventory_transactionGetPayload<object>;
type LineRow = Prisma.inventory_transaction_lineGetPayload<object>;

@Injectable()
export class InventoryTransactionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: TransactionQuery): Promise<PagedResponse<TransactionView>> {
    const range = assertBusinessDateRange(query);
    const page = pageRequest({ page: loose(query.page), size: loose(query.size) });
    // ⛔ 숫자 축은 여기서 «가른다». 질의 문자열을 그대로 Prisma 에 넘기면 글자가 섞였을 때
    // PrismaClientValidationError 가 나는데, 그것은 «알려진» 오류가 아니라 오류 필터의
    // 그물에도 안 걸리고 500 으로 샌다. 사용자가 고칠 수 있는 입력이라 400 이어야 한다.
    const ids = {
      itemId: assertId('itemId', query.itemId),
      lotId: assertId('lotId', query.lotId),
      warehouseId: assertId('warehouseId', query.warehouseId),
      locationId: assertId('locationId', query.locationId),
    };

    const where: Prisma.inventory_transactionWhereInput = {
      business_date: { gte: range.from, lte: range.to },
      ...optional('transaction_type_code', query.transactionTypeCode),
      ...optional('source_document_type_code', query.sourceDocumentTypeCode),
      ...lineFilter(ids),
    };

    const [rows, total] = await Promise.all([
      this.prisma.inventory_transaction.findMany({
        where,
        // 최신이 먼저다. 영업일이 같으면 채번 역순 — 같은 날 안에서도 순서가 흔들리지
        // 않게 두 번째 축을 둔다(쪽을 넘길 때 행이 겹치거나 빠지는 것을 막는다).
        orderBy: [{ business_date: 'desc' }, { inventory_transaction_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inventory_transaction.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(businessDate: string, inventoryTransactionId: number): Promise<TransactionDetail> {
    const date = assertDate('businessDate', businessDate);
    // ⛔ 식별자가 «둘»이다 — 영업일이 파티션 키라 id 만으로는 행을 찾을 수 없다(계약).
    const row = await this.prisma.inventory_transaction.findUnique({
      where: {
        inventory_transaction_id_business_date: {
          inventory_transaction_id: inventoryTransactionId,
          business_date: date,
        },
      },
    });
    if (!row) throw new NotFoundException('없는 수불 거래입니다.');

    const lines = await this.prisma.inventory_transaction_line.findMany({
      where: {
        inventory_transaction_id: row.inventory_transaction_id,
        business_date: row.business_date,
      },
      orderBy: { line_no: 'asc' },
    });
    return { inventoryTransaction: view(row), lines: lines.map(lineView) };
  }
}

/**
 * 라인의 축으로 «헤더»를 고른다 — 그 라인을 하나라도 가진 거래를 내린다.
 *
 * ⭐ 창고는 나간 쪽·들어온 쪽을 **둘 다** 본다. 창고에서 빠져나간 것도 그 창고의
 * 수불이라, 한쪽만 보면 출고가 이력에서 사라진다.
 */
function lineFilter(ids: LineIds): Prisma.inventory_transactionWhereInput {
  const line: Prisma.inventory_transaction_lineWhereInput = {
    ...optional('item_id', ids.itemId),
    ...optional('lot_id', ids.lotId),
    ...(ids.warehouseId === undefined
      ? {}
      : { OR: [{ from_warehouse_id: ids.warehouseId }, { to_warehouse_id: ids.warehouseId }] }),
    // ⚠ 두 번째 「양쪽 끝」 조건은 AND 로 감싼다 — OR 키를 또 쓰면 앞의 창고 조건을
    // 덮어써서 창고 필터가 조용히 사라진다.
    ...(ids.locationId === undefined
      ? {}
      : {
          AND: [
            { OR: [{ from_location_id: ids.locationId }, { to_location_id: ids.locationId }] },
          ],
        }),
  };
  return Object.keys(line).length === 0 ? {} : { inventory_transaction_line: { some: line } };
}

interface LineIds {
  itemId?: number;
  lotId?: number;
  warehouseId?: number;
  locationId?: number;
}

/**
 * 숫자 식별자 축. 없으면 거르지 않고, 글자가 섞였으면 **400** 이다.
 * ⛔ 그냥 넘기면 Prisma 가 `PrismaClientValidationError` 를 던지는데 그것은 오류 필터가
 * 계약 봉투로 옮기지 못하는 부류라 500 이 된다(`prisma-error.ts` 는 «알려진» 오류만 본다).
 */
function assertId(field: string, value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message: '숫자 식별자여야 합니다.' },
  ]);
}

/**
 * ⛔ 영업일 범위는 **필수**다. 이 표는 영업일로 나뉘어 저장되므로 범위 없이 물으면
 * 파티션 전체를 훑는다 — 계약이 그 이유를 적었다(공유계약 `L-3`).
 */
function assertBusinessDateRange(query: TransactionQuery): { from: Date; to: Date } {
  const errors: ErrorItem[] = [];
  for (const field of ['businessDateFrom', 'businessDateTo'] as const) {
    if (query[field] === undefined || query[field] === '') {
      errors.push({
        scope: 'field',
        field,
        code: ERROR_CODE.REQUIRED,
        message: '영업일 범위를 함께 보냅니다.',
      });
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  return {
    from: assertDate('businessDateFrom', query.businessDateFrom as string),
    to: assertDate('businessDateTo', query.businessDateTo as string),
  };
}

/** `@db.Date` 는 UTC 자정으로 저장된다 — 시각을 붙이면 하루가 어긋난다. */
function assertDate(field: string, value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message: 'YYYY-MM-DD 형식입니다.' },
  ]);
}

/** 쪽·크기는 관대하게 본다 — 계약이 기본값을 정해 두어 못 읽으면 그 기본으로 간다. */
function loose(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optional<T>(column: string, value: T | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [column]: value };
}

function view(row: TransactionRow): TransactionView {
  return {
    inventoryTransactionId: Number(row.inventory_transaction_id),
    businessDate: toDateString(row.business_date) as string,
    transactionNo: row.transaction_no,
    transactionTypeCode: row.transaction_type_code,
    plantId: Number(row.plant_id),
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    sourceDocumentTypeCode: row.source_document_type_code,
    sourceDocumentId: Number(row.source_document_id),
    statusCode: row.status_code,
    reversalOfTransactionId:
      row.reversal_of_transaction_id === null ? null : Number(row.reversal_of_transaction_id),
    reversalOfBusinessDate: toDateString(row.reversal_of_business_date),
  };
}

function lineView(row: LineRow): TransactionLineView {
  return {
    inventoryTransactionLineId: Number(row.inventory_transaction_line_id),
    inventoryTransactionId: Number(row.inventory_transaction_id),
    businessDate: toDateString(row.business_date) as string,
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    lotId: row.lot_id === null ? null : Number(row.lot_id),
    qty: qty(row.qty),
    uomId: Number(row.uom_id),
    fromWarehouseId: id(row.from_warehouse_id),
    fromLocationId: id(row.from_location_id),
    fromQualityStatusCode: row.from_quality_status_code,
    fromInventoryStatusCode: row.from_inventory_status_code,
    toWarehouseId: id(row.to_warehouse_id),
    toLocationId: id(row.to_location_id),
    toQualityStatusCode: row.to_quality_status_code,
    toInventoryStatusCode: row.to_inventory_status_code,
    ownershipTypeCode: row.ownership_type_code,
    ownerPartnerId: id(row.owner_partner_id),
    handlingUnitId: id(row.handling_unit_id),
    fromQtyAfterTransaction: row.from_qty_after_transaction === null ? null : qty(row.from_qty_after_transaction),
    toQtyAfterTransaction: row.to_qty_after_transaction === null ? null : qty(row.to_qty_after_transaction),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * 계약이 수량을 `number` 로 선언했다 — 문자열로 내리지 않는다.
 * `Decimal(20,6)` 의 유효숫자는 최대 20자리지만 현장 수량은 double 의 정밀도(약 15자리)
 * 안에 든다. 자리수가 그 밖으로 나갈 업무가 생기면 계약부터 바꿔야 하는 자리다.
 */
function qty(value: Prisma.Decimal): number {
  return Number(value);
}
