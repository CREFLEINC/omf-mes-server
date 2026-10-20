import { Prisma } from '@prisma/client';

import { toDateString } from '../../../common/master';
import { skipOnReceipt } from '../../../planning/production-order/auto-plan';
import { AfterCommit, RowTable, Tx } from '../inbound-cycle';
import { PRODUCTION_ORDER, RelayRow, isCancel, requiredText, text } from '../relay-tables';
import { businessUnitOf, dateOf, itemIdsByCode, plantByCode, plantToday, uomIdsByCode } from './lookup';

/** 시드 `PRODUCTION_ORDER_STATUS`. */
const RECEIVED = 'RECEIVED';
const UPDATED = 'UPDATED';
const CANCELLED = 'CANCELLED';

/**
 * ERP W/O → `planning.production_order`. 원본 한 행이 ERP W/O 하나다.
 *
 * ⭐ ERP 가 보내는 날짜는 계획 시작일(PLAN_START_DT) 하나다 — `planned_start_date` 에 담고 납기
 * (`due_date`)는 비운다. 납기로 도는 MES 쪽은 설계 요청으로 고친다(2026-10-20 결정).
 * 이미 있는 ERP W/O 가 바뀌면 I-24 변경 추적을 남긴다 — 바뀐 항목의 «이전» 값만 갈아 넣고 수신 시각을
 * 찍어 관리자 확인(W-02-06)을 기다린다. 판을 올려 판정 중인 확인을 409 로 막는다.
 * 처음 받은 ERP W/O 는 커밋 뒤 `onReceived` 로 넘긴다(자동 계획). 바뀐 ERP W/O 는 넘기지 않는다 — 변경은 확인 흐름이 맡는다.
 * 넘길지(`skipOnReceipt`)는 여기서 정하고 시도 시각도 같은 트랜잭션에 찍는다 — 커밋 뒤 무엇이 실패해도 「확인 필요」로 남게.
 */
export const productionOrderTable = (onReceived: (productionOrderId: bigint) => Promise<void>): RowTable => ({
  source: PRODUCTION_ORDER,
  async apply(tx: Tx, row: RelayRow): Promise<void | AfterCommit> {
    const orderNo = requiredText(row, 'PRODT_ORDER_NO');
    const plantCode = requiredText(row, 'PLANT_CD');
    const plant = await plantByCode(tx, plantCode);
    const itemCode = requiredText(row, 'ITEM_CD');
    const unit = requiredText(row, 'BASE_UNIT');
    const fixed = {
      plant_id: plant.plant_id,
      item_id: (await itemIdsByCode(tx, [itemCode])).get(itemCode) as bigint,
      uom_id: (await uomIdsByCode(tx, [unit])).get(unit) as bigint,
    };
    const values = {
      order_qty: new Prisma.Decimal(requiredText(row, 'PRODT_ORDER_QTY')),
      planned_start_date: dateOf(requiredText(row, 'PLAN_START_DT')),
      erp_operation_no: requiredText(row, 'OPR_NO'),
      erp_storage_location_code: text(row, 'SL_CD') || null,
      erp_rework_flag: text(row, 'RE_WORK_FLG') || null,
      remarks: text(row, 'REMARK') || null,
    };
    const cancel = isCancel(row);

    const [locked] = await tx.$queryRaw<{ production_order_id: bigint }[]>`
      SELECT production_order_id FROM planning.production_order
       WHERE production_order_no = ${orderNo} FOR UPDATE`;
    if (locked === undefined) {
      const status = cancel ? CANCELLED : RECEIVED;
      const autoPlan = !skipOnReceipt(status, null, toDateString(values.planned_start_date), plantToday(plant));
      const created = await tx.production_order.create({
        data: {
          production_order_no: orderNo,
          erp_order_no: orderNo,
          business_unit_id: businessUnitOf(plantCode, plant),
          ...fixed,
          ...values,
          status_code: status,
          auto_plan_attempted_at: autoPlan ? new Date() : null,
        },
        select: { production_order_id: true },
      });
      return autoPlan ? () => onReceived(created.production_order_id) : undefined;
    }
    const current = await tx.production_order.findUniqueOrThrow({
      where: { production_order_id: locked.production_order_id },
    });
    if (current.erp_order_no !== orderNo) {
      throw new Error(`생산오더 ${orderNo} 이 MES 에서 만든 생산오더와 번호가 겹친다`);
    }
    // 계획·작업지시가 이 값들을 보고 섰다 — 바꾸면 사람이 봐야 한다. 취소는 그래도 받는다.
    if (
      !cancel &&
      (current.plant_id !== fixed.plant_id ||
        current.item_id !== fixed.item_id ||
        current.uom_id !== fixed.uom_id)
    ) {
      throw new Error(`생산오더 ${orderNo} 의 공장·품목·단위가 바뀌었다`);
    }
    await applyChange(tx, current, cancel ? {} : values, cancel ? CANCELLED : undefined);
  },
});

type Order = Prisma.production_orderGetPayload<object>;
type Values = Partial<
  Pick<
    Order,
    | 'order_qty'
    | 'planned_start_date'
    | 'erp_operation_no'
    | 'erp_storage_location_code'
    | 'erp_rework_flag'
    | 'remarks'
  >
>;

/**
 * 바뀐 것이 없으면 아무것도 하지 않는다. 있으면 상태를 UPDATED(취소면 CANCELLED)로 두고 바뀐
 * 항목의 이전 값을 남긴다. 상태 항목은 취소·되살림일 때만 남긴다 — RECEIVED→UPDATED 는 «바뀌었다»
 * 는 표식일 뿐 ERP 가 바꾼 항목이 아니다.
 */
async function applyChange(
  tx: Tx,
  current: Order,
  values: Values,
  cancelTo: string | undefined,
): Promise<void> {
  const changed = differs(current, values);
  const status =
    cancelTo ?? (changed || current.status_code === CANCELLED ? UPDATED : current.status_code);
  if (!changed && status === current.status_code) return;

  const before: Prisma.production_order_change_fieldCreateManyInput[] = [];
  const id = current.production_order_id;
  if (values.order_qty !== undefined && !values.order_qty.equals(current.order_qty)) {
    before.push({
      production_order_id: id,
      field_code: 'ORDER_QTY',
      before_order_qty: current.order_qty,
    });
  }
  if (
    values.planned_start_date !== undefined &&
    !sameDate(values.planned_start_date, current.planned_start_date)
  ) {
    before.push({
      production_order_id: id,
      field_code: 'PLANNED_START_DATE',
      before_planned_start_date: current.planned_start_date,
    });
  }
  if ((status === CANCELLED) !== (current.status_code === CANCELLED)) {
    before.push({
      production_order_id: id,
      field_code: 'STATUS_CODE',
      before_status_code: current.status_code,
    });
  }
  await tx.production_order_change_field.deleteMany({ where: { production_order_id: id } });
  if (before.length > 0) await tx.production_order_change_field.createMany({ data: before });
  await tx.production_order.update({
    where: { production_order_id: id },
    data: {
      ...values,
      status_code: status,
      last_change_received_at: new Date(),
      updated_by: null,
      version_no: { increment: 1 },
    },
  });
}

function differs(current: Order, values: Values): boolean {
  return (Object.keys(values) as (keyof Values)[]).some((key) => {
    const next = values[key];
    const now = current[key];
    if (next instanceof Prisma.Decimal) return !next.equals(now as Prisma.Decimal);
    if (next instanceof Date) return !sameDate(next, now as Date | null);
    return next !== now;
  });
}

function sameDate(a: Date | null, b: Date | null): boolean {
  return a?.getTime() === b?.getTime();
}
