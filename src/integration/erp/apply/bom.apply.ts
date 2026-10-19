import { Prisma } from '@prisma/client';

import { REVISION_STATUS } from '../../../planning/revision-status';
import { Tx, UnitTable } from '../inbound-cycle';
import { BOM, RelayRow, isCancel, requiredText, text } from '../relay-tables';
import { dateOf, itemIdsByCode, plantByCode, plantToday, uomIdsByCode } from './lookup';

type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

/**
 * ERP BOM → `planning.bom` / `bom_component`. 모품목 하나의 행을 묶어 BOM 판 하나로 반영한다.
 *
 * ⭐ ERP 가 고치면 «새 판»을 만든다 — 생산계획·자재 투입이 판(bom_id·bom_component_id)을
 * 가리키므로 그 자리에서 고치면 과거가 바뀐다(2026-10-20 결정). 이전 판은 OBSOLETE 로 닫는다.
 * 값이 그대로면 판을 만들지 않는다.
 */
export const bomTable: UnitTable = {
  source: BOM,
  unitOf: (row) => text(row, 'PRNT_ITEM_CD'),
  async applyUnit(tx: Tx, rows: RelayRow[]): Promise<void> {
    const parentCode = requiredText(rows[0], 'PRNT_ITEM_CD');
    const plantCodes = new Set(rows.map((row) => requiredText(row, 'PLANT_CD')));
    if (plantCodes.size > 1) throw new Error(`모품목 ${parentCode} 의 BOM 이 두 공장에서 왔다`);

    const items = await itemIdsByCode(tx, [
      parentCode,
      ...rows.map((r) => requiredText(r, 'CHILD_ITEM_CD')),
    ]);
    const parentId = items.get(parentCode) as bigint;
    const uoms = await uomIdsByCode(
      tx,
      rows.flatMap((row) => [text(row, 'CHILD_ITEM_UNIT'), text(row, 'PRNT_ITEM_UNIT')]),
    );
    const bomCode = `ERP-${parentCode}`;
    const current = await tx.bom.findFirst({
      where: { parent_item_id: parentId, bom_code: bomCode },
      orderBy: { bom_version: 'desc' },
      include: { bom_component: { orderBy: { sequence_no: 'asc' } } },
    });
    const live =
      current !== null && current.status_code !== REVISION_STATUS.OBSOLETE ? current : null;

    const incoming = rows.map((row) => entryOf(row, items, uoms));
    const kept = incoming.filter((_, i) => !isCancel(rows[i]));
    const adopted = live === null ? [] : adopt(parentCode, live.bom_component, kept);
    const next = new Map<string, Entry>(
      (live?.bom_component ?? []).map((c, i) => {
        const entry: Entry = {
          erpSeq: c.erp_child_item_seq ?? adopted[i],
          itemId: c.component_item_id,
          qty: c.required_qty,
          per: live?.base_qty ?? new Decimal(1),
          uomId: c.uom_id,
          extension: extensionOf(c),
        };
        return [keyOf(entry), entry];
      }),
    );
    incoming.forEach((entry, i) => {
      if (isCancel(rows[i])) next.delete(keyOf(entry));
      else next.set(keyOf(entry), { ...entry, extension: next.get(keyOf(entry))?.extension });
    });

    const entries = [...next.values()].sort(
      (a, b) => a.erpSeq - b.erpSeq || Number(a.itemId - b.itemId),
    );
    const baseQty = lcm(entries.map((entry) => entry.per));
    const baseUomId = await baseUomOf(tx, rows, uoms, parentId);
    const components = entries.map((entry) => ({
      ...entry,
      qty: entry.qty.mul(baseQty.div(entry.per)),
    }));

    if (live !== null && sameBom(live, baseQty, baseUomId, components, adopted)) {
      // 운영 초기 데이터로 들어온 판 — ERP 순번만 채운다. 보이는 값이 그대로라 판을 올리지 않는다.
      for (const [i, component] of live.bom_component.entries()) {
        if (component.erp_child_item_seq !== null) continue;
        await tx.bom_component.update({
          where: { bom_component_id: component.bom_component_id },
          data: { erp_child_item_seq: adopted[i] },
        });
      }
      return;
    }

    const today = plantToday(await plantByCode(tx, [...plantCodes][0]));
    if (live !== null) {
      const from = live.effective_from.toISOString().slice(0, 10);
      await tx.bom.update({
        where: { bom_id: live.bom_id },
        data: {
          is_default: false,
          status_code: REVISION_STATUS.OBSOLETE,
          effective_to: dateOf(today > from ? today : from),
          updated_by: null,
          version_no: { increment: 1 },
        },
      });
    }
    // 구성품이 하나도 안 남으면 ERP 가 BOM 을 지운 것이다 — 이전 판을 닫기만 한다.
    if (components.length === 0) return;
    await tx.bom.create({
      data: {
        parent_item_id: parentId,
        bom_code: bomCode,
        bom_version: (current?.bom_version ?? 0) + 1,
        status_code: REVISION_STATUS.CONFIRMED,
        is_default: true,
        effective_from: dateOf(today),
        base_qty: baseQty,
        base_uom_id: baseUomId,
        bom_component: {
          create: components.map((entry, i) => ({
            component_item_id: entry.itemId,
            required_qty: entry.qty,
            uom_id: entry.uomId,
            sequence_no: i + 1,
            erp_child_item_seq: entry.erpSeq,
            ...entry.extension,
          })),
        },
      },
    });
  },
};

interface Entry {
  erpSeq: number;
  itemId: bigint;
  /** `per` 개의 모품목에 드는 수량. */
  qty: Decimal;
  per: Decimal;
  uomId: bigint;
  /** 이전 판에서 옮겨 적는 MES 확장 칸(공정 연결·LOT 추적 등). 새 구성품이면 기본값. */
  extension?: Extension;
}

type Component = Prisma.bom_componentGetPayload<object>;
type Extension = Pick<
  Component,
  | 'routing_operation_id'
  | 'actual_use_process_id'
  | 'lot_trace_required'
  | 'backflush_allowed'
  | 'scrap_rate'
  | 'is_mandatory'
>;

function extensionOf(c: Component): Extension {
  return {
    routing_operation_id: c.routing_operation_id,
    actual_use_process_id: c.actual_use_process_id,
    lot_trace_required: c.lot_trace_required,
    backflush_allowed: c.backflush_allowed,
    scrap_rate: c.scrap_rate,
    is_mandatory: c.is_mandatory,
  };
}

/** ERP 의 구성품 키 — (순번, 자품목). 같은 자품목이 순번을 달리해 둘 이상 오기도 한다. */
function keyOf(entry: Entry): string {
  return `${entry.erpSeq}|${entry.itemId}`;
}

function entryOf(row: RelayRow, items: Map<string, bigint>, uoms: Map<string, bigint>): Entry {
  const per = new Decimal(String(row.PRNT_ITEM_QTY));
  if (per.lte(0)) {
    throw new Error(`모품목 기준수량이 0 이하다 (${requiredText(row, 'CHILD_ITEM_CD')})`);
  }
  return {
    erpSeq: Number(row.CHILD_ITEM_SEQ),
    itemId: items.get(requiredText(row, 'CHILD_ITEM_CD')) as bigint,
    qty: new Decimal(String(row.CHILD_ITEM_QTY)),
    per,
    uomId: uoms.get(requiredText(row, 'CHILD_ITEM_UNIT')) as bigint,
  };
}

/**
 * 운영 초기 데이터(`deploy/seed/mes-initial-data.sql`)로 들어온 판은 ERP 순번이 비어 있다.
 * 그 판의 구성품을 순서대로 받은 행에 짝지어 순번을 빌려 온다 — 초기 데이터가 ERP 순번(0 이
 * 있으면 +1)으로 sequence_no 를 매겼으므로 순서가 같다. 짝이 안 맞으면 고르지 않고 실패로 남긴다.
 */
function adopt(parentCode: string, components: Component[], incoming: Entry[]): number[] {
  const legacy = components.filter((c) => c.erp_child_item_seq === null);
  if (legacy.length === 0) return [];
  const live = incoming.filter((e, i, all) => all.findIndex((o) => keyOf(o) === keyOf(e)) === i);
  if (legacy.length !== components.length || legacy.length !== live.length) {
    throw new Error(`모품목 ${parentCode} — ERP 순번이 없는 기존 BOM 과 받은 행의 수가 다르다`);
  }
  const ordered = [...live].sort((a, b) => a.erpSeq - b.erpSeq);
  if (legacy.some((c, i) => c.component_item_id !== ordered[i].itemId)) {
    throw new Error(`모품목 ${parentCode} — ERP 순번이 없는 기존 BOM 과 자품목 순서가 다르다`);
  }
  return ordered.map((entry) => entry.erpSeq);
}

function sameBom(
  live: { base_qty: Decimal; base_uom_id: bigint; bom_component: Component[] },
  baseQty: Decimal,
  baseUomId: bigint,
  components: Entry[],
  adopted: number[],
): boolean {
  if (!live.base_qty.equals(baseQty) || live.base_uom_id !== baseUomId) return false;
  if (live.bom_component.length !== components.length) return false;
  const current = live.bom_component
    .map((c, i) => ({ c, erpSeq: c.erp_child_item_seq ?? adopted[i] }))
    .sort((a, b) => a.erpSeq - b.erpSeq || Number(a.c.component_item_id - b.c.component_item_id));
  return current.every(
    ({ c, erpSeq }, i) =>
      erpSeq === components[i].erpSeq &&
      c.component_item_id === components[i].itemId &&
      c.required_qty.equals(components[i].qty) &&
      c.uom_id === components[i].uomId,
  );
}

/**
 * 기준수량. ERP 는 행마다 모품목 기준수량을 따로 싣는데 MES 판은 하나다 — 10개 모품목이 행마다
 * 달랐다(1·16 등). 최소공배수로 맞추면 자품목 수량이 정수배만 되어 값이 정확히 남는다.
 */
function lcm(values: Decimal[]): Decimal {
  if (values.length === 0) return new Decimal(1);
  let result = 1n;
  for (const value of values) {
    if (!value.isInteger()) throw new Error(`모품목 기준수량 ${value.toString()} 이 정수가 아니다`);
    const n = BigInt(value.toFixed(0));
    result = (result / gcd(result, n)) * n;
  }
  return new Decimal(result.toString());
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/** 모품목 단위는 행마다 같아야 한다. 비어 오면(NULL 허용) 모품목 품목의 기본단위다. */
async function baseUomOf(
  tx: Tx,
  rows: RelayRow[],
  uoms: Map<string, bigint>,
  parentId: bigint,
): Promise<bigint> {
  const units = new Set(rows.map((row) => text(row, 'PRNT_ITEM_UNIT')));
  if (units.size > 1) throw new Error(`모품목 단위가 행마다 다르다 (${[...units].join(', ')})`);
  const [unit] = units;
  if (unit !== '') return uoms.get(unit) as bigint;
  const parent = await tx.item.findUniqueOrThrow({ where: { item_id: parentId } });
  return parent.base_uom_id;
}
