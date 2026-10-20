import { Prisma } from '@prisma/client';

import { RowTable, Tx } from '../inbound-cycle';
import { RelayRow, SALES_ORDER, isCancel, requiredText, text } from '../relay-tables';
import { dateOf, itemIdsByCode, partnerIdByCode, uomIdsByCode } from './lookup';

/** 시드 `SALES_ORDER_STATUS`. 수주는 수신본이라 MES 에 상태를 바꾸는 길이 없다 — 이 둘 사이만 오간다. */
const RECEIVED = 'RECEIVED';
const CANCELLED = 'CANCELLED';

/**
 * ERP 수주 → `logistics.sales_order` / `_line`. 발주와 같은 모양이다 — 원본 한 행이 라인 하나.
 *
 * 수주번호는 ERP 번호를 그대로 쓴다. ERP 의 거래처는 하나뿐이라(BP_CD) 판매처·납품처에 같이 둔다.
 * 헤더 칸은 마지막으로 반영한 라인의 값을 따른다. 공장(PLANT_CD)은 수주에 담을 칸이 없어 원본
 * 기록에만 남고, 납기는 ERP 수주에 없어 `requested_delivery_date` 를 비운다.
 */
export const salesOrderTable: RowTable = {
  source: SALES_ORDER,
  async apply(tx: Tx, row: RelayRow): Promise<void> {
    const partnerId = await partnerIdByCode(tx, requiredText(row, 'BP_CD'));
    const header = {
      customer_id: partnerId,
      ship_to_partner_id: partnerId,
      order_date: dateOf(requiredText(row, 'SO_DT')),
      erp_order_type_code: requiredText(row, 'SO_TYPE_CD'),
      erp_movement_type_code: requiredText(row, 'MOV_TYPE'),
      erp_sales_group_code: text(row, 'SALES_GRP_CD') || null,
    };
    const salesOrderId = await upsertHeader(tx, requiredText(row, 'SO_NO'), header);
    await upsertLine(tx, salesOrderId, row);
    await syncStatus(tx, salesOrderId);
  },
};

type Header = Omit<
  Prisma.sales_orderUncheckedCreateInput,
  'sales_order_no' | 'erp_sales_order_no' | 'status_code'
>;

async function upsertHeader(tx: Tx, soNo: string, header: Header): Promise<bigint> {
  const current = await tx.sales_order.findFirst({ where: { erp_sales_order_no: soNo } });
  if (current === null) {
    const created = await tx.sales_order.create({
      data: { sales_order_no: soNo, erp_sales_order_no: soNo, status_code: RECEIVED, ...header },
      select: { sales_order_id: true },
    });
    return created.sales_order_id;
  }
  const changed = (Object.keys(header) as (keyof Header)[]).some(
    (key) => String(current[key as keyof typeof current]) !== String(header[key]),
  );
  if (changed) {
    await tx.sales_order.update({
      where: { sales_order_id: current.sales_order_id },
      data: { ...header, updated_by: null, version_no: { increment: 1 } },
    });
  }
  return current.sales_order_id;
}

async function upsertLine(tx: Tx, salesOrderId: bigint, row: RelayRow): Promise<void> {
  const lineNo = Number(row.SO_SEQ_NO);
  const itemCode = requiredText(row, 'ITEM_CD');
  const unit = requiredText(row, 'BASE_UNIT');
  const values = {
    item_id: (await itemIdsByCode(tx, [itemCode])).get(itemCode) as bigint,
    ordered_qty: new Prisma.Decimal(String(row.SO_QTY)),
    uom_id: (await uomIdsByCode(tx, [unit])).get(unit) as bigint,
    erp_storage_location_code: requiredText(row, 'SL_CD'),
  };
  const cancel = isCancel(row);
  // ⭐ 출하가 이 라인의 `shipped_qty` 를 올린다(헤더는 잠그지 않는다) — 라인을 잠그고 읽어야
  // 아래 막기가 최신 출하 수량을 본다.
  const [locked] = await tx.$queryRaw<{ sales_order_line_id: bigint }[]>`
    SELECT sales_order_line_id FROM logistics.sales_order_line
     WHERE sales_order_id = ${salesOrderId} AND line_no = ${lineNo} FOR UPDATE`;
  if (locked === undefined) {
    await tx.sales_order_line.create({
      data: {
        sales_order_id: salesOrderId,
        line_no: lineNo,
        ...values,
        cancelled_at: cancel ? new Date() : null,
      },
    });
    return;
  }
  const line = await tx.sales_order_line.findUniqueOrThrow({
    where: { sales_order_line_id: locked.sales_order_line_id },
  });

  // 취소는 지우지 않고 시각만 남긴다 — 라인을 가리키는 출하작업지시가 있을 수 있다.
  if (cancel) {
    if (line.cancelled_at === null) {
      await tx.sales_order_line.update({
        where: { sales_order_line_id: line.sales_order_line_id },
        data: { cancelled_at: new Date(), updated_by: null, version_no: { increment: 1 } },
      });
    }
    return;
  }
  const shipped = !line.shipped_qty.isZero();
  if (shipped && (line.item_id !== values.item_id || line.uom_id !== values.uom_id)) {
    throw new Error(`수주 라인 ${lineNo} 은 출하가 있어 품목·단위를 바꿀 수 없다`);
  }
  if (values.ordered_qty.lt(line.shipped_qty)) {
    throw new Error(
      `수주 라인 ${lineNo} 의 수량 ${values.ordered_qty.toString()} 이 출하 수량 ${line.shipped_qty.toString()} 보다 작다`,
    );
  }
  const changed =
    line.item_id !== values.item_id ||
    !line.ordered_qty.equals(values.ordered_qty) ||
    line.uom_id !== values.uom_id ||
    line.erp_storage_location_code !== values.erp_storage_location_code ||
    line.cancelled_at !== null;
  if (changed) {
    await tx.sales_order_line.update({
      where: { sales_order_line_id: line.sales_order_line_id },
      data: { ...values, cancelled_at: null, updated_by: null, version_no: { increment: 1 } },
    });
  }
}

/** 라인이 모두 취소면 수주도 취소, 하나라도 살아 있으면 접수. */
async function syncStatus(tx: Tx, salesOrderId: bigint): Promise<void> {
  const so = await tx.sales_order.findUniqueOrThrow({
    where: { sales_order_id: salesOrderId },
    select: { status_code: true },
  });
  if (so.status_code !== RECEIVED && so.status_code !== CANCELLED) return;
  const live = await tx.sales_order_line.count({
    where: { sales_order_id: salesOrderId, cancelled_at: null },
  });
  const status = live === 0 ? CANCELLED : RECEIVED;
  if (status !== so.status_code) {
    await tx.sales_order.update({
      where: { sales_order_id: salesOrderId },
      data: { status_code: status, updated_by: null, version_no: { increment: 1 } },
    });
  }
}
