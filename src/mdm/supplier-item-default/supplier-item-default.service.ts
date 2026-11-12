import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `MaterialPackageInput` — 단위 코드는 서버가 채운다. */
export interface MaterialPackageInput {
  uomId: number;
  count: number;
  qtyPerPackage: number;
}

/** 계약 `SupplierItemDefaultCreate`. */
export interface SupplierItemDefaultCreate {
  plantId: number;
  supplierId: number;
  itemId: number;
  lotQty: number;
  package?: MaterialPackageInput | null;
  remarks?: string | null;
}

/** 계약 `SupplierItemDefaultUpdate` — 공장·공급사·품목은 바꾸지 않는다(지우고 다시 넣는다). */
export interface SupplierItemDefaultUpdate {
  versionNo: number;
  lotQty: number;
  package?: MaterialPackageInput | null;
  remarks?: string | null;
}

export interface SupplierItemDefaultQuery {
  plantId: unknown;
  supplierId?: unknown;
  itemId?: unknown;
  q?: unknown;
  page?: unknown;
  size?: unknown;
}

const VERSION_CONFLICT = 'VERSION_CONFLICT';

const ROW_INCLUDE = {
  supplier: { select: { partner_code: true, partner_name: true } },
  item: { select: { item_code: true, item_name: true, base_uom_id: true, uom: { select: { uom_code: true } } } },
  package_uom: { select: { uom_code: true } },
} satisfies Prisma.supplier_item_defaultInclude;

type Row = Prisma.supplier_item_defaultGetPayload<{ include: typeof ROW_INCLUDE }>;
export type SupplierItemDefaultView = ReturnType<typeof view>;

/**
 * 공급사·품목 기본 정보(W-06-25 · 피처 005 research R-26). 자재 관리 LOT 발행 화면의 기본값일 뿐이라
 * 이 표를 고치거나 지워도 이미 만든 묶음·자재 관리 LOT 는 건드리지 않는다.
 */
@Injectable()
export class SupplierItemDefaultService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SupplierItemDefaultQuery): Promise<PagedResponse<SupplierItemDefaultView>> {
    const page = pageRequest({ page: num(query.page), size: num(query.size) });
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const contains = (value: string) => ({ contains: value, mode: Prisma.QueryMode.insensitive });
    const where: Prisma.supplier_item_defaultWhereInput = {
      plant_id: num(query.plantId),
      ...(num(query.supplierId) === undefined ? {} : { supplier_id: num(query.supplierId) }),
      ...(num(query.itemId) === undefined ? {} : { item_id: num(query.itemId) }),
      ...(q === ''
        ? {}
        : {
            OR: [
              { supplier: { partner_code: contains(q) } },
              { supplier: { partner_name: contains(q) } },
              { item: { item_code: contains(q) } },
              { item: { item_name: contains(q) } },
            ],
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supplier_item_default.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: [{ supplier: { partner_code: 'asc' } }, { item: { item_code: 'asc' } }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.supplier_item_default.count({ where }),
    ]);
    return pagedResponse(await this.views(this.prisma, rows), total, page);
  }

  async create(tx: Prisma.TransactionClient, body: SupplierItemDefaultCreate, appUserId: number | undefined): Promise<SupplierItemDefaultView> {
    const errors = [...(await referenceErrors(tx, body)), ...valueErrors(body)];
    if (body.package != null) errors.push(...(await packageUomErrors(tx, body.package.uomId)));
    throwIfAny(errors);
    const duplicate = await tx.supplier_item_default.findUnique({
      where: { plant_id_supplier_id_item_id: { plant_id: body.plantId, supplier_id: body.supplierId, item_id: body.itemId } },
      select: { supplier_item_default_id: true },
    });
    if (duplicate !== null) throw duplicateError();
    const row = await tx.supplier_item_default
      .create({
        data: {
          plant_id: body.plantId,
          supplier_id: body.supplierId,
          item_id: body.itemId,
          ...values(body),
          created_by: appUserId ?? null,
          updated_by: appUserId ?? null,
        },
        include: ROW_INCLUDE,
      })
      .catch(rethrowDuplicate);
    return (await this.views(tx, [row]))[0];
  }

  async update(tx: Prisma.TransactionClient, id: number, body: SupplierItemDefaultUpdate, appUserId: number | undefined): Promise<SupplierItemDefaultView> {
    const current = await find(tx, id);
    const errors = valueErrors(body);
    if (body.package != null) errors.push(...(await packageUomErrors(tx, body.package.uomId)));
    throwIfAny(errors);
    const updated = await tx.supplier_item_default.updateMany({
      where: { supplier_item_default_id: id, version_no: body.versionNo },
      data: { ...values(body), updated_at: new Date(), updated_by: appUserId ?? null, version_no: { increment: 1 } },
    });
    assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(current.version_no) });
    return (await this.views(tx, [await find(tx, id)]))[0];
  }

  async remove(tx: Prisma.TransactionClient, id: number): Promise<void> {
    await find(tx, id);
    await tx.supplier_item_default.delete({ where: { supplier_item_default_id: id } });
  }

  /** 바꾼 사람 이름 — `updated_by` 에 관계가 없어 한 번에 따로 읽는다. */
  private async views(db: Prisma.TransactionClient, rows: Row[]): Promise<SupplierItemDefaultView[]> {
    const userIds = [...new Set(rows.flatMap((row) => (row.updated_by === null ? [] : [row.updated_by])))];
    const users =
      userIds.length === 0
        ? []
        : await db.app_user.findMany({ where: { app_user_id: { in: userIds } }, select: { app_user_id: true, user_name: true } });
    const names = new Map(users.map((user) => [user.app_user_id, user.user_name]));
    return rows.map((row) => view(row, row.updated_by === null ? null : (names.get(row.updated_by) ?? null)));
  }
}

async function find(tx: Prisma.TransactionClient, id: number): Promise<Row> {
  const row = await tx.supplier_item_default.findUnique({ where: { supplier_item_default_id: id }, include: ROW_INCLUDE });
  if (row === null) throw new NotFoundException('없는 공급사·품목 기본 정보입니다.');
  return row;
}

/** 공장·공급사·품목이 있고 쓰이는 것인지 — 없는 id 를 FK 위반(500)으로 보내지 않는다. */
async function referenceErrors(tx: Prisma.TransactionClient, body: SupplierItemDefaultCreate): Promise<ErrorItem[]> {
  const [plant, supplier, item] = await Promise.all([
    tx.plant.findUnique({ where: { plant_id: body.plantId }, select: { plant_id: true } }),
    tx.partner.findUnique({ where: { partner_id: body.supplierId }, select: { is_active: true } }),
    tx.item.findUnique({ where: { item_id: body.itemId }, select: { is_active: true } }),
  ]);
  const errors: ErrorItem[] = [];
  if (plant === null) errors.push(field('plantId', ERROR_CODE.INVALID, '없는 공장입니다.'));
  if (supplier === null || !supplier.is_active) errors.push(field('supplierId', ERROR_CODE.INVALID, '없거나 사용 중지된 공급사입니다.'));
  if (item === null || !item.is_active) errors.push(field('itemId', ERROR_CODE.INVALID, '없거나 사용 중지된 품목입니다.'));
  return errors;
}

async function packageUomErrors(tx: Prisma.TransactionClient, uomId: number): Promise<ErrorItem[]> {
  const uom = await tx.uom.findUnique({ where: { uom_id: uomId }, select: { is_active: true } });
  return uom === null || !uom.is_active ? [field('package.uomId', ERROR_CODE.INVALID, '없거나 사용 중지된 패키징 단위입니다.')] : [];
}

/**
 * `ck_supplier_item_default_package` 와 같은 규칙을 DB 에 닿기 전에 본다 — CHECK 위반은 칸을 짚지 못한다.
 * 칸이 numeric(20,6) 이라 소수 여섯째 자리에서 맞춘 값끼리 곱을 견준다(DB 가 저장하며 반올림한 값으로 CHECK 를 본다).
 */
function valueErrors(body: { lotQty: number; package?: MaterialPackageInput | null }): ErrorItem[] {
  const errors: ErrorItem[] = [];
  if (!(body.lotQty > 0)) errors.push(field('lotQty', ERROR_CODE.RANGE, 'LOT 당 수량은 0 보다 커야 합니다.'));
  const pack = body.package;
  if (pack == null) return errors;
  if (!(Number.isInteger(pack.count) && pack.count > 0)) errors.push(field('package.count', ERROR_CODE.RANGE, '패키징 수는 1 이상의 정수여야 합니다.'));
  if (!(pack.qtyPerPackage > 0)) errors.push(field('package.qtyPerPackage', ERROR_CODE.RANGE, '패키징당 수량은 0 보다 커야 합니다.'));
  if (errors.length > 0) return errors;
  const product = new Prisma.Decimal(pack.qtyPerPackage).toDecimalPlaces(6).mul(pack.count);
  if (!product.eq(new Prisma.Decimal(body.lotQty).toDecimalPlaces(6))) {
    errors.push(field('lotQty', ERROR_CODE.INVALID, 'LOT 당 수량은 패키징 수 × 패키징당 수량과 같아야 합니다.'));
  }
  return errors;
}

/** 패키징을 빼면(생략·null) 세 칸을 함께 비운다 — CHECK 가 셋이 함께 있거나 함께 없기를 요구한다. */
function values(body: { lotQty: number; package?: MaterialPackageInput | null; remarks?: string | null }) {
  const pack = body.package ?? null;
  return {
    lot_qty: body.lotQty,
    package_uom_id: pack === null ? null : BigInt(pack.uomId),
    package_count: pack === null ? null : pack.count,
    qty_per_package: pack === null ? null : pack.qtyPerPackage,
    remarks: body.remarks?.trim() || null,
  };
}

function throwIfAny(errors: ErrorItem[]): void {
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function duplicateError(): ContractException {
  return new ContractException(HttpStatus.CONFLICT, [
    { scope: 'screen', code: 'DUPLICATE', message: '이 공장에 같은 공급사·품목의 기본 정보가 이미 있습니다.' },
  ]);
}

/** 사전 확인과 INSERT 사이에 다른 요청이 같은 조합을 넣은 경우. */
function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw duplicateError();
  throw error;
}

function num(value: unknown): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function view(row: Row, updatedByName: string | null) {
  return {
    supplierItemDefaultId: Number(row.supplier_item_default_id),
    plantId: Number(row.plant_id),
    supplierId: Number(row.supplier_id),
    supplierCode: row.supplier.partner_code,
    supplierName: row.supplier.partner_name,
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    uomId: Number(row.item.base_uom_id),
    uomCode: row.item.uom.uom_code,
    lotQty: row.lot_qty.toNumber(),
    package:
      row.package_uom_id === null || row.package_count === null || row.qty_per_package === null
        ? null
        : {
            uomId: Number(row.package_uom_id),
            uomCode: row.package_uom?.uom_code ?? '',
            count: row.package_count,
            qtyPerPackage: row.qty_per_package.toNumber(),
          },
    remarks: row.remarks,
    versionNo: row.version_no,
    updatedAt: row.updated_at.toISOString(),
    updatedByName,
  };
}
