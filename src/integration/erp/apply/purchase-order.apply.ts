import { Prisma } from '@prisma/client';

import { RowTable, Tx } from '../inbound-cycle';
import { PURCHASE_ORDER, RelayRow, isCancel, requiredText, text } from '../relay-tables';
import {
  businessUnitOf,
  dateOf,
  itemIdsByCode,
  partnerIdByCode,
  plantByCode,
  uomIdsByCode,
} from './lookup';

/**
 * 발주 상태 — 시드 `LOGISTICS_DOCUMENT_STATUS`. ERP 발주는 이 둘 사이만 오간다.
 * ⛔ `logistics` 의 상수를 import 하지 않는다 — 연계가 도메인 파일에 기대지 않게 값만 둔다.
 */
const REGISTERED = 'REGISTERED';
const CANCELLED = 'CANCELLED';

/**
 * ERP 발주 → `logistics.purchase_order` / `_line`. 원본 한 행이 라인 하나다.
 *
 * ⭐ ERP 가 발주의 정본이다 — 승인 단계를 거치지 않고 REGISTERED 로 선다. 발주번호는 ERP 번호를
 * 그대로 쓴다(MES 채번 `PO-YYYYMMDD-NNNN` 과 모양이 달라 겹치지 않는다).
 * 헤더 칸은 라인마다 같이 오고, 마지막으로 반영한 라인의 값을 따른다 — 실데이터에서는 한 발주의
 * 라인끼리 모두 같았다. 구매그룹·입출고유형·창고는 구매입고 실적을 ERP 로 돌려보낼 때 원래 값으로
 * 실어야 해 온 그대로 담는다.
 */
export const purchaseOrderTable: RowTable = {
  source: PURCHASE_ORDER,
  async apply(tx: Tx, row: RelayRow): Promise<void> {
    const poNo = requiredText(row, 'PO_NO');
    const plantCode = requiredText(row, 'PLANT_CD');
    const plant = await plantByCode(tx, plantCode);
    const header = {
      supplier_id: await partnerIdByCode(tx, requiredText(row, 'BP_CD')),
      plant_id: plant.plant_id,
      business_unit_id: businessUnitOf(plantCode, plant),
      order_date: dateOf(requiredText(row, 'PO_DT')),
      // DLVY_DT 는 시각까지 담는 칸이지만 모두 00:00 이다 — 그 날짜만 쓴다.
      expected_receipt_date: dateOf((row.DLVY_DT as Date).toISOString().slice(0, 10)),
      erp_order_type_code: requiredText(row, 'PO_TYPE_CD'),
      erp_purchase_group_code: text(row, 'PUR_GRP_CD') || null,
      erp_io_type_code: text(row, 'IO_TYPE_CD') || null,
    };
    const purchaseOrderId = await upsertHeader(tx, poNo, header);
    await upsertLine(tx, purchaseOrderId, row);
    await syncStatus(tx, purchaseOrderId);
  },
};

type Header = Omit<
  Prisma.purchase_orderUncheckedCreateInput,
  'purchase_order_no' | 'erp_purchase_order_no' | 'status_code'
>;

/** ⭐ 헤더를 잠근다 — 입고가 같은 발주를 `FOR UPDATE` 로 잡고 `received_qty` 를 올린다. */
async function upsertHeader(tx: Tx, poNo: string, header: Header): Promise<bigint> {
  const [locked] = await tx.$queryRaw<{ purchase_order_id: bigint }[]>`
    SELECT purchase_order_id FROM logistics.purchase_order
     WHERE erp_purchase_order_no = ${poNo} FOR UPDATE`;
  if (locked === undefined) {
    const created = await tx.purchase_order.create({
      data: {
        purchase_order_no: poNo,
        erp_purchase_order_no: poNo,
        status_code: REGISTERED,
        ...header,
      },
      select: { purchase_order_id: true },
    });
    return created.purchase_order_id;
  }
  const current = await tx.purchase_order.findUniqueOrThrow({
    where: { purchase_order_id: locked.purchase_order_id },
  });
  const changed = (Object.keys(header) as (keyof Header)[]).some(
    (key) => String(current[key as keyof typeof current]) !== String(header[key]),
  );
  if (changed) {
    await tx.purchase_order.update({
      where: { purchase_order_id: current.purchase_order_id },
      data: { ...header, updated_by: null, version_no: { increment: 1 } },
    });
  }
  return current.purchase_order_id;
}

async function upsertLine(tx: Tx, purchaseOrderId: bigint, row: RelayRow): Promise<void> {
  const lineNo = Number(row.PO_SEQ_NO);
  const itemCode = requiredText(row, 'ITEM_CD');
  const unit = requiredText(row, 'BASE_UNIT');
  const values = {
    item_id: (await itemIdsByCode(tx, [itemCode])).get(itemCode) as bigint,
    ordered_qty: new Prisma.Decimal(String(row.PO_QTY)),
    uom_id: (await uomIdsByCode(tx, [unit])).get(unit) as bigint,
    erp_storage_location_code: requiredText(row, 'SL_CD'),
  };
  const cancel = isCancel(row);
  const line = await tx.purchase_order_line.findUnique({
    where: { purchase_order_id_line_no: { purchase_order_id: purchaseOrderId, line_no: lineNo } },
  });
  if (line === null) {
    await tx.purchase_order_line.create({
      data: {
        purchase_order_id: purchaseOrderId,
        line_no: lineNo,
        ...values,
        cancelled_at: cancel ? new Date() : null,
      },
    });
    return;
  }

  // 취소는 지우지 않고 시각만 남긴다 — 라인을 가리키는 입고·ASN 이 있을 수 있다.
  if (cancel) {
    if (line.cancelled_at === null) {
      await tx.purchase_order_line.update({
        where: { purchase_order_line_id: line.purchase_order_line_id },
        data: { cancelled_at: new Date(), updated_by: null, version_no: { increment: 1 } },
      });
    }
    return;
  }
  const received = !line.received_qty.isZero();
  if (received && (line.item_id !== values.item_id || line.uom_id !== values.uom_id)) {
    throw new Error(`발주 라인 ${lineNo} 은 입고가 있어 품목·단위를 바꿀 수 없다`);
  }
  if (values.ordered_qty.plus(line.tolerance_over_qty).lt(line.received_qty)) {
    throw new Error(
      `발주 라인 ${lineNo} 의 수량 ${values.ordered_qty.toString()} 이 입고 수량 ${line.received_qty.toString()} 보다 작다`,
    );
  }
  const changed =
    line.item_id !== values.item_id ||
    !line.ordered_qty.equals(values.ordered_qty) ||
    line.uom_id !== values.uom_id ||
    line.erp_storage_location_code !== values.erp_storage_location_code ||
    line.cancelled_at !== null;
  if (changed) {
    await tx.purchase_order_line.update({
      where: { purchase_order_line_id: line.purchase_order_line_id },
      data: { ...values, cancelled_at: null, updated_by: null, version_no: { increment: 1 } },
    });
  }
}

/** 라인이 모두 취소면 헤더도 취소, 하나라도 살아 있으면 등록. 다른 상태는 건드리지 않는다. */
async function syncStatus(tx: Tx, purchaseOrderId: bigint): Promise<void> {
  const po = await tx.purchase_order.findUniqueOrThrow({
    where: { purchase_order_id: purchaseOrderId },
    select: { status_code: true },
  });
  if (po.status_code !== REGISTERED && po.status_code !== CANCELLED) return;
  const live = await tx.purchase_order_line.count({
    where: { purchase_order_id: purchaseOrderId, cancelled_at: null },
  });
  const status = live === 0 ? CANCELLED : REGISTERED;
  if (status !== po.status_code) {
    await tx.purchase_order.update({
      where: { purchase_order_id: purchaseOrderId },
      data: { status_code: status, updated_by: null, version_no: { increment: 1 } },
    });
  }
}
