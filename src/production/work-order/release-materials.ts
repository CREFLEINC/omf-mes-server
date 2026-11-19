import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { ErrorItem } from '../../common/errors/error-response';
import {
  MaterialIssueLine,
  StockUomTable,
  commonOverridable,
  itemRatio,
  loadStockUomTable,
  stockQtyOf,
  toStockUom,
} from '../../core/bom';

/** 계약 `WorkOrderRelease.materialUomConfirmations[]` — `conversionRate` 는 「1 재고 단위 = N BOM 단위」. */
export interface MaterialUomConfirmation {
  bomComponentId: number;
  confirmed: boolean;
  conversionRate?: number;
}

/** 배포 확인에서 사람이 넣은 비율 — 배포 트랜잭션에서 품목 환산으로 저장한다. */
export interface EnteredConversion {
  itemId: bigint;
  stockUomId: bigint;
  bomUomId: bigint;
  rate: Prisma.Decimal;
  /** 넣기 전 출처 — 공통 환산을 이 품목에서 바꾼 것인지, 환산이 없던 것인지. */
  replacedSource: 'COMMON' | 'NONE';
  bomComponentIds: number[];
}

export interface ReleaseMaterials {
  /** 재고 단위 줄 — 출고요청·피킹·가용 비교가 모두 이것을 쓴다. */
  lines: MaterialIssueLine[];
  entered: EnteredConversion[];
}

/** 감사 대상 유형은 계약 `CD-AUDIT-TARGET-TYPE` 의 값이다 — 품목 환산은 따로 없어 품목에 남긴다. */
const ITEM_AUDIT_TARGET = 'ITEM';
export const ITEM_UOM_CONVERSION_ENTERED_AT_RELEASE = 'ITEM_UOM_CONVERSION_ENTERED_AT_RELEASE';

/** `rate_t` 가 numeric(18,8) 이다 — 저장될 자릿수로 맞춰야 저장값과 비교·계산이 같다. */
const RATE_SCALE = 8;

/**
 * 배포가 담을 자재를 재고 단위로 바꾼다. 단위가 다른 자재는 사람이 확인해야 한다 — 환산이 없으면 비율을 받는다.
 * `automatic`(추적 시스템 연동의 자동 배포)은 확인할 사람이 없어 품목·공통 환산을 그대로 쓰고, 환산이 없으면 막는다
 * (막힌 까닭은 자동 실행기가 기록한다). ⛔ 트랜잭션 밖이다 — 채번보다 먼저 막으려고 `releasePlan` 이 부른다.
 */
export async function releaseMaterials(
  db: Parameters<typeof loadStockUomTable>[0],
  input: {
    /** BOM 단위의 소요 줄 — 사람이 세운 W/O 는 그 공정의 BOM 행, 라인 없는 자동 W/O 는 BOM 끝 자재다. */
    required: MaterialIssueLine[];
    plantToday: string;
    confirmations: MaterialUomConfirmation[] | undefined;
    automatic: boolean;
  },
): Promise<ReleaseMaterials> {
  const { required } = input;
  if (required.length === 0) return { lines: [], entered: [] };
  const table = await loadStockUomTable(db, required.map((line) => line.item_id), input.plantToday);
  const confirmations = new Map((input.confirmations ?? []).map((row) => [row.bomComponentId, row]));
  const errors: ErrorItem[] = [];
  const entered = new Map<string, EnteredConversion>();
  const lines = required.map((line) => {
    const conversion = toStockUom(table, line.item_id, line.uom_id, line.requested_qty);
    if (conversion.source === null) return line;
    const converted = (stockQty: Prisma.Decimal) => ({ ...line, requested_qty: stockQty, uom_id: conversion.stockUomId });
    const componentId = Number(line.bom_component_id);
    const at = `materialUomConfirmations[bomComponentId=${componentId}]`;
    if (input.automatic) {
      if (conversion.stockQty !== null) return converted(conversion.stockQty);
      errors.push(field(at, ERROR_CODE.MATERIAL_UOM_CONFIRMATION_REQUIRED, `${uomLabel(table, line)} — 품목 환산이 없어 자동 배포할 수 없습니다.`));
      return line;
    }
    const confirmation = confirmations.get(componentId);
    if (confirmation?.confirmed !== true) {
      errors.push(field(`${at}.confirmed`, ERROR_CODE.MATERIAL_UOM_CONFIRMATION_REQUIRED, `${uomLabel(table, line)} — 단위 환산을 확인해야 배포합니다.`));
      return line;
    }
    if (confirmation.conversionRate == null) {
      if (conversion.stockQty !== null) return converted(conversion.stockQty);
      errors.push(field(`${at}.conversionRate`, ERROR_CODE.MATERIAL_UOM_CONFIRMATION_REQUIRED, `${uomLabel(table, line)} — 환산이 없어 비율을 입력해야 배포합니다.`));
      return line;
    }
    const rate = new Prisma.Decimal(confirmation.conversionRate).toDecimalPlaces(RATE_SCALE, Prisma.Decimal.ROUND_HALF_UP);
    if (rate.lte(0)) {
      errors.push(field(`${at}.conversionRate`, ERROR_CODE.RANGE, `비율은 0 보다 커야 합니다(소수 ${RATE_SCALE}자리까지).`));
      return line;
    }
    if (conversion.source === 'ITEM') {
      // 품목 환산은 여기서 덮어쓰지 않는다 — 고치려면 기준정보의 품목 환산 화면에서 한다.
      if (!sameRate(conversion.rate, rate)) {
        errors.push(field(`${at}.conversionRate`, ERROR_CODE.INVALID, `${uomLabel(table, line)} — 이미 품목 환산(1 : ${(conversion.rate as Prisma.Decimal).toString()})이 있습니다. 기준정보에서 고치세요.`));
      }
      return converted(conversion.stockQty as Prisma.Decimal);
    }
    if (conversion.source === 'COMMON' && !commonOverridable(table, conversion.stockUomId, line.uom_id)) {
      if (!sameRate(conversion.rate, rate)) {
        errors.push(field(`${at}.conversionRate`, ERROR_CODE.INVALID, `${uomLabel(table, line)} — 공통 환산이 정해진 단위라 비율을 바꿀 수 없습니다.`));
      }
      return converted(conversion.stockQty as Prisma.Decimal);
    }
    const key = `${line.item_id}:${conversion.stockUomId}:${line.uom_id}`;
    const seen = entered.get(key);
    if (seen !== undefined && !seen.rate.eq(rate)) {
      errors.push(field(`${at}.conversionRate`, ERROR_CODE.INVALID, '같은 품목·단위에 다른 비율을 넣었습니다.'));
      return line;
    }
    if (seen === undefined) {
      entered.set(key, { itemId: line.item_id, stockUomId: conversion.stockUomId, bomUomId: line.uom_id, rate, replacedSource: conversion.source, bomComponentIds: [componentId] });
    } else {
      seen.bomComponentIds.push(componentId);
    }
    return converted(stockQtyOf(table, conversion.stockUomId, line.requested_qty, { rate }));
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return { lines, entered: [...entered.values()] };
}

function sameRate(existing: Prisma.Decimal | null, entered: Prisma.Decimal): boolean {
  return existing !== null && existing.toDecimalPlaces(RATE_SCALE, Prisma.Decimal.ROUND_HALF_UP).eq(entered);
}

function uomLabel(table: StockUomTable, line: MaterialIssueLine): string {
  const stock = table.uoms.get(table.stockUomOf.get(line.item_id) ?? line.uom_id)?.code ?? '';
  return `${table.itemCodeOf.get(line.item_id) ?? ''} BOM 단위 ${table.uoms.get(line.uom_id)?.code ?? ''} · 재고 단위 ${stock}`;
}

/**
 * 배포 트랜잭션 안에서 저장한다. 품목 환산의 잠금은 품목 `version_no` 다 — 기준정보 화면(`item-detail.service.ts`
 * `replaceUomConversions`)이 그 버전으로 환산을 통째로 갈아 끼우므로, 올리지 않으면 열어 둔 화면이 저장할 때 여기서 넣은 환산을
 * 409 없이 지운다. 올리는 갱신이 품목 행을 잠가 같은 품목의 동시 배포도 줄을 세운다 — 그 뒤에 다시 읽어, 먼저 들어간 환산이
 * 같은 비율이면 넘어가고 다르면 막는다.
 */
export async function saveEnteredConversions(
  tx: Prisma.TransactionClient,
  entered: EnteredConversion[],
  context: { workOrderId: number; plantToday: string; actorId: number | null; correlationId: string | null },
): Promise<void> {
  if (entered.length === 0) return;
  // 잠금 순서를 품목 id 로 고정한다 — 두 배포가 같은 품목 둘을 거꾸로 잡으면 교착된다.
  const itemIds = [...new Set(entered.map((row) => row.itemId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const itemId of itemIds) {
    await tx.item.update({ where: { item_id: itemId }, data: { version_no: { increment: 1 } }, select: { item_id: true } });
  }
  const table = await loadStockUomTable(tx, itemIds, context.plantToday);
  const day = new Date(`${context.plantToday}T00:00:00.000Z`);
  const occurredAt = new Date();
  for (const row of entered) {
    const existing = itemRatio(table, row.itemId, row.stockUomId, row.bomUomId);
    if (existing !== null) {
      if (sameRate(existing.rate, row.rate)) continue;
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(`materialUomConfirmations[bomComponentId=${row.bomComponentIds[0]}].conversionRate`, ERROR_CODE.INVALID, '배포하는 사이 이 품목에 다른 환산이 등록됐습니다. 다시 확인하세요.'),
      ]);
    }
    const saved = await tx.item_uom_conversion.create({
      data: {
        item_id: row.itemId,
        from_uom_id: row.stockUomId,
        to_uom_id: row.bomUomId,
        conversion_rate: row.rate,
        effective_from: day,
        created_by: context.actorId,
      },
      select: { item_uom_conversion_id: true },
    });
    await tx.audit_event.create({
      data: {
        occurred_at: occurredAt,
        target_type_code: ITEM_AUDIT_TARGET,
        target_id: row.itemId,
        event_type_code: 'CREATE',
        performed_by: context.actorId === null ? null : BigInt(context.actorId),
        correlation_id: context.correlationId,
        after_value: {
          eventCode: ITEM_UOM_CONVERSION_ENTERED_AT_RELEASE,
          detail: {
            itemUomConversionId: Number(saved.item_uom_conversion_id),
            fromUomId: Number(row.stockUomId),
            toUomId: Number(row.bomUomId),
            conversionRate: row.rate.toNumber(),
            effectiveFrom: context.plantToday,
            replacedSource: row.replacedSource,
            workOrderId: context.workOrderId,
            bomComponentIds: row.bomComponentIds,
          },
        },
      },
    });
  }
}
