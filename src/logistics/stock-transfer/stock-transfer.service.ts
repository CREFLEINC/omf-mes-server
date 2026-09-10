import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues, assertWorkerNoExists } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { StockTransferQueryService } from './stock-transfer-query.service';
import { StockTransferDetail } from './stock-transfer-view';
import { TransferLineWriteInput, postTransferIssue } from './transfer-posting';

/**
 * 재고 이동 «반출 등록». ⭐ 생성과 반출이 **한 오퍼레이션**이라 라인은 태어나는 순간
 * 전량 반출이 끝나 있다(계약 `StockTransferCreate.description` — 도출 단계의 `:depart` 가
 * 없다). 그래서 이 한 호출이 전표·라인 INSERT 와 **원장 1단째 전기**를 함께 한다.
 */

/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다(입고와 같은 판정). */
const NUMBER_RETRY = 3;
const REGISTERED = 'REGISTERED';

interface LockedHeader {
  shipped_at: Date | null;
  version_no: number;
}

export interface StockTransferLineCreate {
  itemId: number;
  lotId: number;
  requestedQty: number;
  uomId: number;
  fromLocationId: number;
  toLocationId: number;
  handlingUnitId?: number | null;
  /** ⛔ 무시한다 — 신규 전표라 짚을 기존 행이 없다(계약이 치환 스키마를 함께 써서 남은 칸). */
  stockTransferLineId?: number | null;
}

export interface StockTransferCreate {
  transferTypeCode: string;
  fromBusinessUnitId: number;
  toBusinessUnitId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  businessDate: string;
  occurredAt: string;
  requestedAt?: string | null;
  lines: StockTransferLineCreate[];
}

@Injectable()
export class StockTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: StockTransferQueryService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
  ) {}

  async create(
    input: StockTransferCreate,
    workerNo: string | undefined,
    appUserId: number,
  ): Promise<{ detail: StockTransferDetail; versionNo: number }> {
    await assertWorkerNoExists(this.prisma, workerNo);
    const plantId = await this.assertWritable(input);

    for (let attempt = 0; ; attempt += 1) {
      try {
        // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 열린 트랜잭션 안에서 부르면 한
        //    요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2.md R-2).
        const transferNo = await this.numbering.next('STOCK_TRANSFER', plantId, input.businessDate);
        const id = await this.prisma.$transaction((tx) => this.write(tx, input, transferNo, appUserId));
        const { stockTransfer, lines, versionNo } = await this.queries.get(Number(id));
        return { detail: { stockTransfer, lines }, versionNo };
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '이동번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /** 전표·라인 INSERT → 반출 전기 → 되짚기. 한 트랜잭션이다(I-13.md §4-4). */
  private async write(
    tx: Prisma.TransactionClient,
    input: StockTransferCreate,
    transferNo: string,
    appUserId: number,
  ): Promise<bigint> {
    const occurredAt = new Date(input.occurredAt);
    const header = await tx.stock_transfer.create({
      data: {
        stock_transfer_no: transferNo,
        transfer_type_code: input.transferTypeCode,
        from_business_unit_id: input.fromBusinessUnitId,
        to_business_unit_id: input.toBusinessUnitId,
        from_warehouse_id: input.fromWarehouseId,
        to_warehouse_id: input.toWarehouseId,
        // ⭐ 안 보내면 «호출자가 이미 준» 반출 시각을 쓴다 — `new Date()` 로 지어내지 않는다
        //    (채번 `periodDate` 규약과 같은 처방 · C-8 정신).
        requested_at: input.requestedAt == null ? occurredAt : new Date(input.requestedAt),
        // 생성과 반출이 한 오퍼레이션이라 태어나는 순간 반출이 끝나 있다.
        shipped_at: occurredAt,
        status_code: REGISTERED,
        created_by: appUserId,
        updated_by: appUserId,
        stock_transfer_line: {
          create: input.lines.map((line, index) => ({
            // 계약 「서버가 부여하며 화면이 정하지 않는다」.
            line_no: index + 1,
            item_id: line.itemId,
            lot_id: line.lotId,
            requested_qty: line.requestedQty,
            // CHECK `shipped_qty <= requested_qty` 를 등호로 지난다.
            shipped_qty: line.requestedQty,
            uom_id: line.uomId,
            from_location_id: line.fromLocationId,
            to_location_id: line.toLocationId,
            handling_unit_id: line.handlingUnitId ?? null,
            created_by: appUserId,
          })),
        },
      },
      select: {
        stock_transfer_id: true,
        stock_transfer_line: {
          orderBy: { line_no: 'asc' },
          select: { stock_transfer_line_id: true },
        },
      },
    });

    const lines: TransferLineWriteInput[] = input.lines.map((line, index) => ({
      stockTransferLineId: header.stock_transfer_line[index].stock_transfer_line_id,
      itemId: BigInt(line.itemId),
      lotId: BigInt(line.lotId),
      qty: new Prisma.Decimal(line.requestedQty),
      uomId: BigInt(line.uomId),
      fromLocationId: BigInt(line.fromLocationId),
      toLocationId: BigInt(line.toLocationId),
      handlingUnitId: line.handlingUnitId == null ? null : BigInt(line.handlingUnitId),
    }));

    const ledgerLineIds = await postTransferIssue(
      tx,
      this.posting,
      {
        stockTransferId: header.stock_transfer_id,
        stockTransferNo: transferNo,
        fromWarehouseId: BigInt(input.fromWarehouseId),
        toWarehouseId: BigInt(input.toWarehouseId),
        lines,
        businessDate: input.businessDate,
        occurredAt,
      },
      appUserId,
    );
    for (const [index, line] of lines.entries()) {
      await tx.stock_transfer_line.update({
        where: { stock_transfer_line_id: line.stockTransferLineId },
        data: { issue_transaction_line_id: ledgerLineIds[index] },
      });
    }
    return header.stock_transfer_id;
  }

  /**
   * 라인 치환의 **자물쇠까지만**이다(통보 123) — 잠그고·찾고·대조하고 «거절만» 한다.
   * ⛔ 본문 `items` 를 한 칸도 안 읽는다. 형제 출고가 404 «앞»에서 빈 배열을 400
   *    `LINE_REQUIRED` 로 막는 그 한 단을 «일부러» 뺐다(`goods-issue-update.service.ts:56-60`)
   *    — 치환 본체가 없어 `items` 를 볼 이유가 0이다.
   * ⛔ 치환 본체를 짓지 않는다 — 오늘 실재하는 모든 전표가 `shipped_at IS NOT NULL` 이라
   *    아래 400 이 유일한 출구고, 호출자가 0인 코드다(`CLAUDE.md`). 본체가 서는 날
   *    `stock-transfer-update.service.ts` 로 뺀다(형제 둘의 형상).
   */
  async replaceLines(stockTransferId: number, version: number): Promise<never> {
    const locked = await this.prisma.$transaction((tx) => lockHeader(tx, stockTransferId, version));
    if (locked.shipped_at !== null) {
      throw one(field('items', ERROR_CODE.STATE_LOCKED, '반출이 끝난 이동의 라인은 바꿀 수 없습니다.'));
    }
    // ⛔ 오늘 여기 닿을 수 없다 — 반출 전 상태를 만드는 오퍼레이션이 계약에 0건이다(POST 가
    //    생성·반출을 한 번에 하고 x-internal-note 가 `:depart` 를 없앴다 · 통보 123).
    //    ⭐ 위 400 으로 «같이» 닫지 않는다 — 그러면 `shipped_at` 을 아예 안 읽는 구현과 모든
    //    테스트가 같아져 자물쇠가 조용히 사라져도 아무도 모른다.
    throw new Error('반출 전 재고 이동 전표가 실재한다 — 계약 전제가 깨졌다(문의 123).');
  }

  /**
   * ⛔ 없는 id 를 그냥 넘기면 FK 위반이 **500** 으로 샌다 — 원장까지 열고 나서 터지므로
   * 여기서 먼저 본다(입고 `assertWritable` 선례). 번호가 곧 판정 순서다(I-13.md §4-2).
   * 돌려주는 것은 채번의 공장 축이다 — 출발 창고가 준다.
   */
  private async assertWritable(input: StockTransferCreate): Promise<bigint> {
    const errors: ErrorItem[] = [];
    // ⭐ 물리 CHECK `ck_stock_transfer_warehouses` 는 2026-08-26 에 DROP 됐다 — 계약
    //    `StockTransfer.description` 「출발 창고와 도착 창고가 같을 수 없다」를 지키는
    //    그물이 서버뿐이다(I-13.md §2-2 · 문의 121).
    if (input.fromWarehouseId === input.toWarehouseId) {
      errors.push(field('toWarehouseId', ERROR_CODE.INVALID, '출발 창고와 도착 창고가 같을 수 없습니다.'));
    }
    // 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다.
    if (input.lines.length === 0) {
      errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '이동 라인이 1건 이상이어야 합니다.'));
    }
    if (Number.isNaN(Date.parse(input.occurredAt))) {
      errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
      errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(this.prisma, [
      { field: 'transferTypeCode', value: input.transferTypeCode, groupCode: 'STOCK_TRANSFER_TYPE' },
    ]);

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: input.fromWarehouseId },
      select: { plant_id: true },
    });
    if (!warehouse) throw one(field('fromWarehouseId', ERROR_CODE.INVALID, '없는 창고입니다.'));
    await this.assertLines(input, errors);
    return warehouse.plant_id;
  }

  private async assertLines(input: StockTransferCreate, errors: ErrorItem[]): Promise<void> {
    for (const [index, line] of input.lines.entries()) {
      const at = `lines[${index}]`;
      // 위치 그물 셋 — 존재 · `is_active` · 짝 창고 소속(적치 §3-3 그대로).
      const [from, to, lot, uom, handlingUnit] = await Promise.all([
        this.activeLocation(line.fromLocationId, input.fromWarehouseId),
        this.activeLocation(line.toLocationId, input.toWarehouseId),
        this.prisma.lot.findUnique({ where: { lot_id: line.lotId }, select: { item_id: true } }),
        this.prisma.uom.findUnique({ where: { uom_id: line.uomId }, select: { uom_id: true } }),
        line.handlingUnitId == null
          ? Promise.resolve(1)
          : this.prisma.handling_unit.count({ where: { handling_unit_id: line.handlingUnitId } }),
      ]);
      const bad = (name: string, message: string): number =>
        errors.push(field(`${at}.${name}`, ERROR_CODE.INVALID, message));
      if (!from) bad('fromLocationId', '이 창고의 쓸 수 있는 위치가 아닙니다.');
      if (!to) bad('toLocationId', '이 창고의 쓸 수 있는 위치가 아닙니다.');
      // CHECK `ck_stock_transfer_locations` 를 앞질러 낸다 — 그냥 넘기면 500 이다.
      if (line.fromLocationId === line.toLocationId) bad('toLocationId', '출발 위치와 도착 위치가 같을 수 없습니다.');
      if (!uom) bad('uomId', '없는 단위입니다.');
      if (handlingUnit === 0) bad('handlingUnitId', '없는 취급 단위입니다.');
      // LOT 과 품목이 어긋나면 원장이 거짓을 적는다 — 계보가 그 두 축으로 이어진다.
      if (!lot) bad('lotId', '없는 LOT 입니다.');
      else if (Number(lot.item_id) !== line.itemId) bad('itemId', '이 LOT 의 품목이 아닙니다.');
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async activeLocation(locationId: number, warehouseId: number): Promise<boolean> {
    const row = await this.prisma.location.findFirst({
      where: { location_id: locationId, warehouse_id: warehouseId, is_active: true },
      select: { location_id: true },
    });
    return row !== null;
  }
}

/**
 * 헤더를 잠그고 버전을 대조한다 — 형제 둘(`inventory-adjustment-update.service.ts:194-207` ·
 * 출고)의 복제다. ⛔ 잠금을 빼면 도착이 그 사이 `version_no` 를 올려도(`transfer-arrive.service.ts:146`)
 * stale 한 값으로 대조를 통과해 **경쟁 시 409 대신 400** 이 나간다.
 */
async function lockHeader(
  tx: Prisma.TransactionClient,
  stockTransferId: number,
  version: number,
): Promise<LockedHeader> {
  const [locked] = await tx.$queryRaw<LockedHeader[]>`
    SELECT shipped_at, version_no
      FROM logistics.stock_transfer
     WHERE stock_transfer_id = ${BigInt(stockTransferId)}
       FOR UPDATE`;
  if (locked === undefined) throw new NotFoundException('없는 재고 이동입니다.');
  // 존재는 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 «토큰»은 풀린다).
  if (locked.version_no !== version) assertUpdated(0);
  return locked;
}

/** `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return (
    Array.isArray(target) &&
    target.some((column) => ['stock_transfer_no', 'transaction_no'].includes(String(column)))
  );
}
