import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BalanceLockKey, lockBalancesInOrder } from './balance-lock';
import {
  PostingEndpoint,
  PostingInput,
  PostingLine,
  PostingResult,
  ReverseInput,
  ReverseResult,
} from './posting.types';
import {
  REVERSAL_NO_SUFFIX,
  assertReversible,
  findReversal,
  insertReversalHeader,
  reversedLine,
} from './reversal';

/** 잔량 행이 서려면 조직 축 셋이 필요한데, 창고가 그것을 안다. */
interface OrgAxis {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
}

/**
 * 재고를 바꾸는 **유일한 길**.
 *
 * ⛔ 도메인 서비스가 `inventory_balance` 를 직접 UPDATE 하지 않는다 — 결정 08 의
 * 「잔량 직접 덮어쓰기 금지」가 그 뜻이고, 원장 트리거가 UPDATE·DELETE 를 막는다
 * (정정은 역트랜잭션이다).
 *
 * ⛔ 유형 → 무엇을 움직인다 표를 두지 않는다. `TRANSACTION_TYPE` 값 목록이 아직
 * 미확정이라(`omf-mes#213`) 그 표를 지금 만들면 정해지지 않은 정책을 지어내는 것이 된다.
 * 대신 **라인의 `from`/`to` 가 이동을 말한다** — 유형 목록 없이도 완전하다.
 *
 * ⛔ `reserved_qty`·`picked_qty` 는 건드리지 않는다. 원장 라인에 그 칸이 없고, 예약은
 * `inventory.inventory_reservation` 이 정본이다. 별도 코어다.
 */
@Injectable()
export class InventoryPostingService {
  /** 호출자가 연 트랜잭션 «안»에서 돈다 — 한 오퍼레이션이 한 트랜잭션이다. */
  async post(tx: Prisma.TransactionClient, input: PostingInput): Promise<PostingResult> {
    const existing = await tx.inventory_transaction.findFirst({
      where: {
        idempotency_key: input.idempotencyKey,
        business_date: new Date(input.businessDate),
      },
      select: { inventory_transaction_id: true },
    });
    // 재전송을 흡수한다. UNIQUE (idempotency_key, business_date) 가 정본이고 이 조회는
    // 그것을 앞당겨 보는 것뿐이다 — 경합은 아래 INSERT 가 유일 위반으로 받는다.
    if (existing) {
      return {
        inventoryTransactionId: existing.inventory_transaction_id,
        businessDate: input.businessDate,
        alreadyPosted: true,
      };
    }

    // 첫 `move()` «앞»에 라인 전건의 from·to 잔액 행을 id 오름차순으로 한 번에 잠근다 —
    // `:cancel`(id 오름차순)과 `POST /goods-receipts`(라인 순서)가 같은 두 행을 반대 순서로
    // 잡는 교착 창을 닫는다(I-4 R-1 ①② · I-5 R-5). 잠글 뿐 판정하지 않는다.
    await lockBalancesInOrder(tx, await this.balanceKeys(tx, input.lines));

    const header = await tx.inventory_transaction.create({
      data: {
        business_date: new Date(input.businessDate),
        transaction_no: input.transactionNo,
        transaction_type_code: input.transactionTypeCode,
        plant_id: input.plantId,
        occurred_at: input.occurredAt,
        source_document_type_code: input.sourceDocumentTypeCode,
        source_document_id: input.sourceDocumentId,
        status_code: input.statusCode,
        idempotency_key: input.idempotencyKey,
        ...(input.createdBy === undefined ? {} : { created_by: input.createdBy }),
      },
      select: { inventory_transaction_id: true },
    });
    for (const [index, line] of input.lines.entries()) {
      await this.writeLine(tx, header.inventory_transaction_id, input, line, index + 1);
    }

    return {
      inventoryTransactionId: header.inventory_transaction_id,
      businessDate: input.businessDate,
      alreadyPosted: false,
    };
  }

  /**
   * 전기된 원장을 되돌린다 — 원 라인의 `from`/`to` 를 **맞바꾼** 새 트랜잭션을 만든다.
   * 부호를 뒤집지 않는 이유는 라인의 `qty > 0` CHECK 다(I-5.md §3-2).
   *
   * 역트랜잭션의 영업일은 원 트랜잭션의 것이다 — `:cancel` 이 `businessDate` 를 안 받는다
   * (계약 실측). 서버가 수신 시각으로 다시 잡지 않는다(C-8 · CLAUDE.md). 04 `ShipmentCancel`
   * 은 같은 행위에 `businessDate` 를 required 로 실었다 — I-5.md §3-4 · 문의 032.
   *
   * ⛔ 되짚기 칸(`goods_receipt_line.inventory_transaction_line_id` 등)은 건드리지 않는다 —
   * 「이 문서 라인이 어느 원장 줄로 들어갔나」는 취소해도 사실이다(B-3 이력 불변).
   */
  async reverse(tx: Prisma.TransactionClient, input: ReverseInput): Promise<ReverseResult> {
    const businessDate = new Date(input.businessDate);
    // 키가 `REVERSAL:` 이 아니어도 「이미 되돌렸다」가 사실이다 — I-14 가 `post()` 로 낸
    // 역분개도 같은 짝 칸을 채운다(I-5 R-3).
    const already = await findReversal(tx, input.inventoryTransactionId, businessDate);
    if (already !== null) return already;

    const original = await tx.inventory_transaction.findUniqueOrThrow({
      where: {
        inventory_transaction_id_business_date: {
          inventory_transaction_id: input.inventoryTransactionId,
          business_date: businessDate,
        },
      },
      include: { inventory_transaction_line: { orderBy: { line_no: 'asc' } } },
    });
    const rows = original.inventory_transaction_line;
    const lines = rows.map(reversedLine);
    const transactionNo = `${original.transaction_no}${REVERSAL_NO_SUFFIX}`;

    assertReversible(lines, await lockBalancesInOrder(tx, await this.balanceKeys(tx, lines)));

    // 잠금 뒤 되읽기가 경합의 그물이다 — INSERT 의 P2002 를 잡아 되읽는 길은 abort 된 tx 안이라
    // 25P02 로 막힌다(리뷰 #217). 두 `reverse()` 가 같은 잔액 행을 잡으므로 뒤 트랜잭션은 앞이
    // 커밋한 뒤에야 잠금을 얻고, READ COMMITTED 재조회가 앞이 만든 역행을 본다.
    const won = await findReversal(tx, input.inventoryTransactionId, businessDate);
    if (won !== null) return won;

    const header = await insertReversalHeader(tx, input, original, transactionNo);

    for (const [index, line] of lines.entries()) {
      // 원 `line_no` 를 그대로 쓴다 — 헤더가 달라 `uq_inventory_transaction_line` 을 안 깨고
      // 원 라인과 1:1 로 읽힌다.
      const lineNo = rows[index].line_no;
      await this.writeLine(tx, header.inventory_transaction_id, input, line, lineNo);
    }

    return {
      inventoryTransactionId: header.inventory_transaction_id,
      transactionNo,
      businessDate: input.businessDate,
      alreadyReversed: false,
    };
  }

  /**
   * ⛔ 잔량을 먼저 옮기고 그 결과를 라인에 적는다 — `from`/`to_qty_after_transaction` 은
   * 「이 전기 «뒤»의 잔량」이라 순서가 뜻을 정한다.
   */
  private async writeLine(
    tx: Prisma.TransactionClient,
    headerId: bigint,
    input: { businessDate: string; occurredAt: Date; createdBy?: number },
    line: PostingLine,
    lineNo: number,
  ): Promise<void> {
    const at = input.occurredAt;
    const fromAfter = line.from ? await this.move(tx, at, line, line.from, -line.qty) : null;
    const toAfter = line.to ? await this.move(tx, at, line, line.to, line.qty) : null;

    await tx.inventory_transaction_line.create({
      data: {
        inventory_transaction_id: headerId,
        business_date: new Date(input.businessDate),
        line_no: lineNo,
        item_id: line.itemId,
        ...(line.lotId === undefined ? {} : { lot_id: line.lotId }),
        qty: line.qty,
        uom_id: line.uomId,
        ...this.endpointColumns('from', line.from),
        ...this.endpointColumns('to', line.to),
        ownership_type_code: line.ownershipTypeCode,
        ...(line.ownerPartnerId === undefined ? {} : { owner_partner_id: line.ownerPartnerId }),
        ...(line.handlingUnitId === undefined ? {} : { handling_unit_id: line.handlingUnitId }),
        ...(fromAfter === null ? {} : { from_qty_after_transaction: fromAfter }),
        ...(toAfter === null ? {} : { to_qty_after_transaction: toAfter }),
        ...(input.createdBy === undefined ? {} : { created_by: input.createdBy }),
      },
    });
  }

  /** 라인 전건의 from·to 를 한 문장에 담을 7칸 키로 편다 — 조직 3축은 창고가 안다. */
  private async balanceKeys(
    tx: Prisma.TransactionClient,
    lines: PostingLine[],
  ): Promise<BalanceLockKey[]> {
    const keys: BalanceLockKey[] = [];
    for (const line of lines) {
      for (const endpoint of [line.from, line.to]) {
        if (endpoint === undefined) continue;
        keys.push({
          ...(await this.orgAxis(tx, endpoint.warehouseId)),
          warehouseId: BigInt(endpoint.warehouseId),
          locationId: BigInt(endpoint.locationId),
          itemId: BigInt(line.itemId),
          lotKey: BigInt(line.lotId ?? 0),
        });
      }
    }
    return keys;
  }

  private endpointColumns(
    side: 'from' | 'to',
    endpoint: PostingEndpoint | undefined,
  ): Record<string, unknown> {
    if (!endpoint) return {};
    return {
      [`${side}_warehouse_id`]: endpoint.warehouseId,
      [`${side}_location_id`]: endpoint.locationId,
      [`${side}_quality_status_code`]: endpoint.qualityStatusCode,
      [`${side}_inventory_status_code`]: endpoint.inventoryStatusCode,
    };
  }

  /**
   * 한 차원의 `on_hand_qty` 를 `delta` 만큼 옮기고 옮긴 «뒤»의 값을 준다.
   *
   * ⛔ `INSERT … ON CONFLICT DO UPDATE` 를 쓸 수 없다. `check_balance_qty()` 가
   * **BEFORE INSERT** 라, PostgreSQL 이 충돌을 감지하기 «전»에 트리거를 돌린다 —
   * 출고(음수 delta)면 병합되기 전에 「음수재고 미허용」으로 걸린다. 실측으로 확인했다.
   *
   * 그래서 두 걸음이다.
   *   ① 잔량 0 인 행을 `ON CONFLICT DO NOTHING` 으로 만든다 — 0 은 언제나 트리거를 지난다.
   *   ② 그 행을 UPDATE 한다 — 트리거가 «최종» 값을 본다.
   * ①이 행의 존재를 보장하므로 ②에 경합이 없다(누가 먼저 만들었든 UPDATE 는 그 행을 잠근다).
   *
   * ⛔ 원시 SQL 인 이유 — 차원 유일 인덱스가 `COALESCE(lot_id, 0)` 같은 **표현식 인덱스**라
   * Prisma 의 `upsert` 로 겨냥할 수 없다.
   */
  private async move(
    tx: Prisma.TransactionClient,
    occurredAt: Date,
    line: PostingLine,
    endpoint: PostingEndpoint,
    delta: number,
  ): Promise<Prisma.Decimal> {
    const org = await this.orgAxis(tx, endpoint.warehouseId);
    const lotId = line.lotId === undefined ? null : BigInt(line.lotId);
    const ownerId = line.ownerPartnerId === undefined ? null : BigInt(line.ownerPartnerId);
    const warehouseId = BigInt(endpoint.warehouseId);
    const locationId = BigInt(endpoint.locationId);
    const itemId = BigInt(line.itemId);

    await tx.$executeRaw`
      INSERT INTO inventory.inventory_balance
        (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id, lot_id,
         quality_status_code, inventory_status_code, ownership_type_code, owner_partner_id,
         on_hand_qty, uom_id)
      VALUES
        (${org.legalEntityId}, ${org.businessUnitId}, ${org.plantId},
         ${warehouseId}, ${locationId}, ${itemId}, ${lotId},
         ${endpoint.qualityStatusCode}, ${endpoint.inventoryStatusCode},
         ${line.ownershipTypeCode}, ${ownerId}, 0, ${BigInt(line.uomId)})
      ON CONFLICT (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id,
                   COALESCE(lot_id, 0::bigint), quality_status_code, inventory_status_code,
                   ownership_type_code, COALESCE(owner_partner_id, 0::bigint))
      DO NOTHING`;

    const rows = await tx.$queryRaw<{ on_hand_qty: Prisma.Decimal }[]>`
      UPDATE inventory.inventory_balance
         SET on_hand_qty = on_hand_qty + ${delta},
             last_transaction_at = ${occurredAt},
             version_no = version_no + 1
       WHERE legal_entity_id = ${org.legalEntityId}
         AND business_unit_id = ${org.businessUnitId}
         AND plant_id = ${org.plantId}
         AND warehouse_id = ${warehouseId}
         AND location_id = ${locationId}
         AND item_id = ${itemId}
         AND COALESCE(lot_id, 0::bigint) = COALESCE(${lotId}::bigint, 0::bigint)
         AND quality_status_code = ${endpoint.qualityStatusCode}
         AND inventory_status_code = ${endpoint.inventoryStatusCode}
         AND ownership_type_code = ${line.ownershipTypeCode}
         AND COALESCE(owner_partner_id, 0::bigint) = COALESCE(${ownerId}::bigint, 0::bigint)
      RETURNING on_hand_qty`;

    return rows[0].on_hand_qty;
  }

  private async orgAxis(tx: Prisma.TransactionClient, warehouseId: number): Promise<OrgAxis> {
    const warehouse = await tx.warehouse.findUniqueOrThrow({
      where: { warehouse_id: warehouseId },
      select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } },
    });
    return {
      legalEntityId: warehouse.plant.legal_entity_id,
      businessUnitId: warehouse.business_unit_id,
      plantId: warehouse.plant_id,
    };
  }
}
