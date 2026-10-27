import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertWorkerNoExists } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import {
  LinkedShipment, LockedRepack, RepackSync, assertNotInShippingUnit, countLiveAllocations, linkedShipmentOf, lockShipmentForRepack,
  syncShipment,
} from '../../logistics/shipment/shipment-repack';
import { planAllocationChanges } from '../../logistics/shipment/shipment-repack-plan';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { HandlingUnitContentView, handlingUnitContentView } from './handling-unit-view';
import {
  HandlingUnitContentUpsert,
  HandlingUnitContext,
  assertContentQty,
  assertNoDuplicateContent,
} from './handling-unit.service';

type Tx = Prisma.TransactionClient;

/** 계약 `HandlingUnitRepackEvent.repackTypeCode` enum 3값 중 하나 · 2값 중 하나. */
const REPACK_TYPE_RECONFIGURE = 'RECONFIGURE';
const ROLE_SOURCE = 'SOURCE';
const ROLE_RESULT = 'RESULT';

/**
 * 이력 라인 한 줄. `qtyBefore` 는 **`Decimal` 그대로** 나른다 — `app.qty_t` 가
 * `numeric(20,6)` 이라 `Number()` 로 접으면 유효숫자 17자리를 넘는 자리에서 값이 바뀌고,
 * 이력이 실제로 있던 수량과 다른 값을 적는다(`inbound-receipt-update.service.ts:180-182`
 * 와 같은 가름 · 계획 §5-3 · 단위 7).
 */
interface RepackLine {
  itemId: number;
  lotId: number;
  qtyBefore: Prisma.Decimal | number;
  qtyAfter: Prisma.Decimal | number;
  uomIdBefore: number | null;
  uomIdAfter: number | null;
  roleCode: string;
}

/**
 * `PUT /inventory/handling-units/{handlingUnitId}/contents` — 구성 «전량 치환»(PR ④).
 * 계획 `docs/coverage-100/slices/I-16-a2.md` §5.
 *
 * ⛔ 원장을 안 부른다 — `inventory_balance` 차원에 `handling_unit_id` 가 없다(§2-5·§3-5).
 * ⛔ `status_code` 를 안 옮긴다 — 치환은 확정도 해제도 아니라 `PACKED` 인 포장도 치환된다.
 */
@Injectable()
export class HandlingUnitContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * ⭐ `version` 이 **선택**이다 — 이 경로의 If-Match 는 `IfMatchVersionOptional` 이고
   * 그 토큰은 **부모** `GET …/{handlingUnitId}` 의 ETag 다(계약 · 공유계약 B-1-1·C-9).
   * ⛔ 응답에 ETag 를 안 붙인다(계약 미선언) — 화면은 다음 토큰을 상세 GET 으로 받는다.
   */
  async replace(
    handlingUnitId: number,
    version: number | undefined,
    items: HandlingUnitContentUpsert[],
    context: HandlingUnitContext,
    reason?: string,
  ): Promise<{ items: HandlingUnitContentView[]; shipmentCorrection?: RepackSync }> {
    await assertWorkerNoExists(this.prisma, context.workerNo);
    // 잠글 필요가 없는 검사는 트랜잭션 «밖»이다(형제 치환과 같은 순서 · §5-2 ③).
    assertNoDuplicateContent(items, 'items');
    assertContentQty(items, 'items');
    const huId = BigInt(handlingUnitId);
    // 출하에 배분된 상자는 출하·재고까지 맞춘다(장부 P-125). 채번은 트랜잭션 «밖»이다 — 출하 등록과 같은 이유.
    const link = await linkedShipmentOf(this.prisma, huId);
    const trimmed = reason?.trim() ?? '';
    if (link !== null && trimmed === '') {
      throw one(field('reason', ERROR_CODE.REQUIRED, '출하에 배분된 상자를 고치려면 사유를 입력하세요 — 사유는 출하 정정 이력에 남습니다.'));
    }
    const goodsIssueNo = link?.businessDate == null ? undefined
      : await this.numbering.next('GOODS_ISSUE', link.plantId, link.businessDate);

    return this.prisma.$transaction(async (tx) => {
      const repack = link === null ? null : await lockShipmentForRepack(tx, link.shipmentId);
      const versionNo = await lockHandlingUnit(tx, handlingUnitId, version);
      if (link !== null) await assertNotInShippingUnit(tx, huId);
      await assertSameLink(tx, huId, link, repack);
      // ⭐ 잠근 «뒤»에 치환 전 구성을 읽는다 — 먼저 읽으면 두 치환이 겹칠 때 앞의 결과를
      //    못 보고 `qty_before` 를 잃는다(§5-2 ⑥ · 단위 3).
      const before = await tx.handling_unit_content.findMany({
        where: { handling_unit_id: handlingUnitId },
        select: { item_id: true, lot_id: true, qty: true, uom_id: true },
      });
      await assertReferences(tx, items);
      const sync = repack === null ? null
        : await this.syncShipment(tx, huId, repack, before, items, goodsIssueNo, context);

      await tx.handling_unit_content.deleteMany({ where: { handling_unit_id: handlingUnitId } });
      await tx.handling_unit_content.createMany({
        data: items.map((line) => ({
          handling_unit_id: handlingUnitId,
          item_id: line.itemId,
          lot_id: line.lotId,
          qty: line.qty,
          uom_id: line.uomId,
          created_by: context.appUserId ?? null,
        })),
      });
      await writeRepackEvent(tx, handlingUnitId, before, items, context);

      // ⛔ `status_code` 는 «안» 옮긴다 · `updated_at` 은 `app.set_updated_at()` 트리거 몫이다.
      const bumped = await tx.handling_unit.updateMany({
        where: { handling_unit_id: handlingUnitId, version_no: versionNo },
        data: { version_no: { increment: 1 }, updated_by: context.appUserId ?? null },
      });
      // 잠그고 비교했으니 0행일 수 없다 — 그래도 조건을 걸어 둔다(같은 축의 마지막 그물).
      assertUpdated(bumped.count);

      if (context.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
        actor: context.terminalAudit, targetTypeCode: 'HANDLING_UNIT', targetId: BigInt(handlingUnitId),
        eventTypeCode: 'REPACK',
      });
      if (repack !== null) await writeCorrectionAudit(tx, huId, before, items, trimmed, sync, context);

      const rows = await tx.handling_unit_content.findMany({
        where: { handling_unit_id: handlingUnitId },
        orderBy: { handling_unit_content_id: 'asc' },
      });
      return { items: rows.map(handlingUnitContentView), ...(sync === null ? {} : { shipmentCorrection: sync }) };
    });
  }

  private async syncShipment(
    tx: Tx, huId: bigint, repack: LockedRepack,
    before: { item_id: bigint; lot_id: bigint; qty: Prisma.Decimal; uom_id: bigint }[],
    items: HandlingUnitContentUpsert[], goodsIssueNo: string | undefined, context: HandlingUnitContext,
  ): Promise<RepackSync | null> {
    const lotIds = [...new Set([...before.map((row) => row.lot_id), ...items.map((line) => BigInt(line.lotId))])];
    const lots = await tx.lot.findMany({ where: { lot_id: { in: lotIds } }, select: { lot_id: true, lot_no: true } });
    const lotNo = new Map(lots.map((lot) => [lot.lot_id, lot.lot_no]));
    const changes = planAllocationChanges(
      huId,
      before.map((row) => ({ itemId: row.item_id, lotId: row.lot_id, uomId: row.uom_id, qty: row.qty })),
      items.map((line) => ({ itemId: BigInt(line.itemId), lotId: BigInt(line.lotId), uomId: BigInt(line.uomId), qty: new Prisma.Decimal(line.qty) })),
      repack.allocations,
      (lotId) => lotNo.get(lotId) ?? String(lotId),
    );
    if (changes.length === 0) return null;
    if (goodsIssueNo === undefined) throw new Error(`출하에 살아 있는 출고가 없어 새 출고 번호를 못 뽑았다: ${repack.shipmentNo}`);
    return syncShipment(tx, this.posting, { locked: repack, changes, goodsIssueNo, appUserId: context.appUserId, now: new Date() });
  }
}

/** 트랜잭션 밖에서 본 출하 연결이 잠근 뒤에도 같아야 한다 — 그사이 배분이 이어지거나 풀렸으면 다시 불러오게 한다. */
async function assertSameLink(tx: Tx, huId: bigint, link: LinkedShipment | null, repack: LockedRepack | null): Promise<void> {
  const linked = await countLiveAllocations(tx, huId);
  const expected = repack === null ? 0 : repack.allocations.filter((row) => row.handlingUnitId === huId).length;
  if (link === null ? linked === 0 : linked === expected && expected > 0) return;
  throw new ConflictException('user', '그사이 이 상자의 출하 배분이 바뀌었습니다 — 상자를 다시 불러온 뒤 고치세요.');
}

/** 출하에 배분된 상자의 정정 — 고치기 전·후 구성, 사유, 출하·재고를 맞춘 결과(옛·새 출고 번호와 배분 증감). */
async function writeCorrectionAudit(
  tx: Tx, huId: bigint,
  before: { item_id: bigint; lot_id: bigint; qty: Prisma.Decimal; uom_id: bigint }[],
  items: HandlingUnitContentUpsert[], reason: string, sync: RepackSync | null, context: HandlingUnitContext,
): Promise<void> {
  await tx.audit_event.create({ data: {
    occurred_at: new Date(),
    target_type_code: 'HANDLING_UNIT',
    target_id: huId,
    event_type_code: 'HANDLING_UNIT_CONTENTS_CHANGED',
    before_value: { contents: before.map((row) => ({
      itemId: Number(row.item_id), lotId: Number(row.lot_id), qty: row.qty.toString(), uomId: Number(row.uom_id),
    })) },
    after_value: { contents: items.map((line) => ({ ...line, qty: String(line.qty) })), shipment: sync === null ? null : { ...sync } },
    reason,
    performed_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
    terminal_id: context.terminalAudit?.terminalId ?? null,
    correlation_id: context.terminalAudit?.correlationId ?? null,
  } });
}

/**
 * ⭐⭐ 자리 ② — **부모를 «먼저» 잠근다.** I-27 발행이 같은 두 표를 부모
 * `inventory.handling_unit`(`FOR NO KEY UPDATE`) → 자식 `handling_unit_content`(`FOR SHARE`)
 * 순서로 잠근다(`document-issue-simple-lock.ts` `lockUnits`). 자식을 먼저 만지면 그 경로와
 * **교착**한다. 세기는 이쪽이 위다 — 우리는 부모 행을 실제로 UPDATE 한다.
 *
 * ⚠ 없는 취급 단위가 **404**(계약 미선언 · 서버가 낸다) 고 버전 어긋남이 **409** 다 —
 *   순서를 바꾸면 없는 id 가 409 로 보인다.
 */
async function lockHandlingUnit(
  tx: Tx,
  handlingUnitId: number,
  version: number | undefined,
): Promise<number> {
  const rows = await tx.$queryRaw<{ version_no: number }[]>`
    SELECT version_no
      FROM inventory.handling_unit
     WHERE handling_unit_id = ${BigInt(handlingUnitId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 취급 단위입니다.');
  // If-Match 는 선택이다 — 안 보내면 낙관적 잠금 검사를 건너뛴다(공유계약 C-9).
  if (version !== undefined && rows[0].version_no !== version) assertUpdated(0);
  return rows[0].version_no;
}

/**
 * ⭐ 이력을 «언제나» 남긴다 — 치환이 아무것도 안 바꿔도 헤더 한 건을 만든다. 계약 원문에
 * 조건절이 없고 「그 시점의 구성 전체」가 이력으로 더 쓸모 있다(§5-3 · 통보 144ⓑ).
 *
 * `occurred_at` 은 **서버 시각**이다 — 요청 본문에 `occurredAt` 이 없다.
 * `repack_type_code` 는 **`RECONFIGURE` 고정** — 본문에 그 칸이 없고 수량 모양으로
 * `MERGE`/`SPLIT` 을 추론하지 않는다(통보 143ⓐ).
 */
async function writeRepackEvent(
  tx: Tx,
  handlingUnitId: number,
  before: { item_id: bigint; lot_id: bigint; qty: Prisma.Decimal; uom_id: bigint }[],
  items: HandlingUnitContentUpsert[],
  actor: HandlingUnitContext,
): Promise<void> {
  const lines = repackLines(before, items);
  await tx.handling_unit_repack_event.create({
    data: {
      repack_type_code: REPACK_TYPE_RECONFIGURE,
      performed_by: actor.appUserId ?? null,
      performed_worker_id: actor.workerId ?? null,
      occurred_at: new Date(),
      lines: {
        create: lines.map((line, index) => ({
          line_no: index + 1,
          // ⛔ 다른 HU 를 안 건드리므로 라인은 전부 경로의 그 HU 다 — 합병은 클라이언트가
          //    `PUT` 을 여러 번 쏘는 모양이 된다(통보 143ⓑ · 145).
          handling_unit_id: handlingUnitId,
          role_code: line.roleCode,
          item_id: line.itemId,
          lot_id: line.lotId,
          qty_before: line.qtyBefore,
          qty_after: line.qtyAfter,
          uom_id_before: line.uomIdBefore,
          uom_id_after: line.uomIdAfter,
        })),
      },
    },
  });
}

/**
 * 치환 «전» 맵과 «후» 맵의 **합집합**을 돈다(§5-3 표).
 *
 * ⭐⭐ `uomIdBefore`·`uomIdAfter` 가 R-2(통보 165)의 자리다. `uq_handling_unit_content` 가
 * `(handling_unit_id, item_id, lot_id)` 라 **같은 (item, lot) 의 단위만 바뀌는 치환**
 * (`10 EA` → `10 BOX`)이 성립하는데, 이 두 칸을 안 채우면 그 사건이 이력에
 * `qty_before === qty_after` 「변화 없음」으로만 남고 마이그가 forward-only 라 **그 사이
 * 기록은 영구 복구 불가**다. ⛔ 응답에는 싣지 않는다 — 계약 라인 6칸에 그 자리가 없다.
 *
 * 정렬은 `(role_code DESC, item_id ASC, lot_id ASC)` — `'SOURCE' > 'RESULT'` 라 DESC 가
 * SOURCE 를 위로 올린다.
 */
function repackLines(
  before: { item_id: bigint; lot_id: bigint; qty: Prisma.Decimal; uom_id: bigint }[],
  items: HandlingUnitContentUpsert[],
): RepackLine[] {
  const lines = new Map<string, RepackLine>();
  for (const row of before) {
    const line: RepackLine = {
      itemId: Number(row.item_id),
      lotId: Number(row.lot_id),
      qtyBefore: row.qty,
      qtyAfter: 0,
      uomIdBefore: Number(row.uom_id),
      uomIdAfter: null,
      roleCode: ROLE_SOURCE,
    };
    lines.set(contentKey(line.itemId, line.lotId), line);
  }
  for (const item of items) {
    const existing = lines.get(contentKey(item.itemId, item.lotId));
    if (existing === undefined) {
      lines.set(contentKey(item.itemId, item.lotId), {
        itemId: item.itemId,
        lotId: item.lotId,
        // 최초 채움 포함 — 전에 없던 줄의 「전 수량」은 0 이고 「전 단위」는 «없음»이다.
        qtyBefore: 0,
        qtyAfter: item.qty,
        uomIdBefore: null,
        uomIdAfter: item.uomId,
        roleCode: ROLE_RESULT,
      });
      continue;
    }
    existing.qtyAfter = item.qty;
    existing.uomIdAfter = item.uomId;
    existing.roleCode = ROLE_RESULT;
  }
  return [...lines.values()].sort(
    (left, right) =>
      compareDesc(left.roleCode, right.roleCode) ||
      left.itemId - right.itemId ||
      left.lotId - right.lotId,
  );
}

function contentKey(itemId: number, lotId: number): string {
  return `${itemId} ${lotId}`;
}

function compareDesc(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0;
}

/**
 * 참조 존재 확인. ⚠ **404 를 안 낸다** — 없는 품목·LOT·단위는 본문이 틀린 것이다
 * ⇒ 400 `INVALID`(등록과 같은 가름 · §5-6). 그냥 넘기면 FK 위반이 500 으로 샌다.
 *
 * ⚠ 배열 이름이 오퍼레이션마다 다르다 — 치환은 `items`, `:pack` 은 `contents` 다. `field` 가
 *   요청 본문의 «그 자리»를 짚어야 화면이 어느 줄인지 안다(`assertNoDuplicateContent` 와 같은 축).
 */
export async function assertReferences(
  tx: Tx,
  items: HandlingUnitContentUpsert[],
  arrayField = 'items',
): Promise<void> {
  if (items.length === 0) return;
  const found = await tx.item.findMany({
    where: { item_id: { in: items.map((line) => line.itemId) } },
    select: { item_id: true },
  });
  const lots = await tx.lot.findMany({
    where: { lot_id: { in: items.map((line) => line.lotId) } },
    select: { lot_id: true },
  });
  const uoms = await tx.uom.findMany({
    where: { uom_id: { in: items.map((line) => line.uomId) } },
    select: { uom_id: true },
  });

  const itemIds = new Set(found.map((row) => Number(row.item_id)));
  const lotIds = new Set(lots.map((row) => Number(row.lot_id)));
  const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
  const errors: ErrorItem[] = [];
  const missing = (name: string): number =>
    errors.push(field(name, ERROR_CODE.INVALID, '없는 식별자입니다.'));

  items.forEach((line, index) => {
    if (!itemIds.has(line.itemId)) missing(`${arrayField}[${index}].itemId`);
    if (!lotIds.has(line.lotId)) missing(`${arrayField}[${index}].lotId`);
    if (!uomIds.has(line.uomId)) missing(`${arrayField}[${index}].uomId`);
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
