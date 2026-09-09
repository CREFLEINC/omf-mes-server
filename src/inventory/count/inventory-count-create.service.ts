import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { IdempotencyContext, IdempotencyService } from '../../common/idempotency';
import { assertCodeValues } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryCountQueryService } from './inventory-count-query.service';
import { InventoryCountDetail } from './inventory-count-view';

export interface InventoryCountCreate {
  countTypeCode: string;
  warehouseId: number;
  plannedDate: string;
  blindCount?: boolean;
}

interface SnapshotRow {
  location_id: bigint;
  item_id: bigint;
  lot_id: bigint | null;
  uom_id: bigint;
  system_qty: Prisma.Decimal;
}

const TYPE_GROUP = 'INVENTORY_COUNT_TYPE';
const NUMBER_RETRY = 3;

@Injectable()
export class InventoryCountCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: InventoryCountQueryService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    input: InventoryCountCreate,
    context: IdempotencyContext & { appUserId: number },
  ): Promise<{ detail: InventoryCountDetail; versionNo: number }> {
    const replay = await this.idempotency.replayExisting<{
      detail: InventoryCountDetail;
      versionNo: number;
    }>(context);
    if (replay !== undefined) return replay.body;

    await assertCodeValues(this.prisma, [
      { field: 'countTypeCode', value: input.countTypeCode, groupCode: TYPE_GROUP },
    ]);
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: input.warehouseId },
      select: { warehouse_id: true, plant_id: true },
    });
    if (warehouse === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('warehouseId', ERROR_CODE.INVALID, '없는 창고입니다.'),
      ]);
    }

    for (let attempt = 0; attempt <= NUMBER_RETRY; attempt += 1) {
      // NumberingService는 자체 커넥션을 잡으므로 멱등 트랜잭션을 열기 전에 부른다.
      const inventoryCountNo = await this.numbering.next(
        'INVENTORY_COUNT',
        warehouse.plant_id,
        input.plannedDate,
      );
      try {
        const outcome = await this.idempotency.run(context, (tx) =>
          this.createWithin(
            tx,
            input,
            warehouse.warehouse_id,
            inventoryCountNo,
            context.appUserId,
          ),
        );
        return outcome.body;
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
      }
    }
    throw new ConflictException('user', '실사번호를 매기지 못했습니다. 다시 시도해 주세요.');
  }

  private async createWithin(
    tx: Prisma.TransactionClient,
    input: InventoryCountCreate,
    warehouseId: bigint,
    inventoryCountNo: string,
    appUserId: number,
  ): Promise<{ detail: InventoryCountDetail; versionNo: number }> {
    const snapshot = await snapshotOf(tx, warehouseId);
    const negative = snapshot.find((row) => row.system_qty.isNegative());
    if (negative !== undefined) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(
          'warehouseId',
          ERROR_CODE.INVALID,
          '음수 장부가 있어 실사를 시작할 수 없습니다. 설계 질의 276의 회신이 필요합니다.',
        ),
      ]);
    }
    const countedAt = new Date();
    const created = await tx.inventory_count.create({
      data: {
        inventory_count_no: inventoryCountNo,
        count_type_code: input.countTypeCode,
        warehouse_id: warehouseId,
        planned_date: new Date(`${input.plannedDate}T00:00:00.000Z`),
        blind_count: input.blindCount ?? false,
        status_code: 'IN_PROGRESS',
        created_by: appUserId,
        updated_by: appUserId,
        inventory_count_line: {
          create: snapshot.map((row, index) => ({
            line_no: index + 1,
            location_id: row.location_id,
            item_id: row.item_id,
            lot_id: row.lot_id,
            system_qty: row.system_qty,
            counted_qty: 0,
            uom_id: row.uom_id,
            counted_at: countedAt,
            counted: false,
            created_by: appUserId,
          })),
        },
      },
      select: { inventory_count_id: true },
    });
    return this.queries.getWithin(tx, Number(created.inventory_count_id));
  }
}

/** 라인이 보존하는 네 축으로 실제 장부 on_hand를 합친다. 음수도 장부 사실이라 자르지 않는다(통보 276). */
export async function snapshotOf(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  warehouseId: bigint,
): Promise<SnapshotRow[]> {
  return tx.$queryRaw<SnapshotRow[]>`
    SELECT location_id, item_id, lot_id, uom_id, SUM(on_hand_qty) AS system_qty
      FROM inventory.inventory_balance
     WHERE warehouse_id = ${warehouseId}
     GROUP BY location_id, item_id, lot_id, uom_id
    HAVING SUM(on_hand_qty) <> 0
     ORDER BY location_id ASC, item_id ASC, lot_id ASC NULLS FIRST, uom_id ASC`;
}

/** `uq` 위반이 실사번호 때문일 때만 새 번호를 뽑는다. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.some((column) => String(column) === 'inventory_count_no');
}
