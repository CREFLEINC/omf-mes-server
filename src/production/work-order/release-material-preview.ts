import { NotFoundException } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { loadStockUomTable, materialRequirements, stockUomLines } from '../../core/bom';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { bomComponents } from './release-plan';

/** 계약 `WorkOrderMaterialRequirement` — 배포 확인 화면의 자재 소요 표 한 행(BOM 구성 행마다). */
export interface WorkOrderMaterialRequirement {
  bomComponentId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  bomQty: number;
  bomUomId: number;
  bomUomCode: string;
  stockUomId: number;
  stockUomCode: string;
  /** 재고 단위 소수 자릿수 — 화면이 직접 넣은 비율로 변환 수량을 보일 때 같은 자릿수로 올림한다. */
  stockUomScale: number;
  stockQty: number | null;
  conversionSource: 'ITEM' | 'COMMON' | 'NONE' | null;
  conversionRate: number | null;
  confirmationRequired: boolean;
}

/**
 * `GET /production/work-orders/{id}/material-requirements` — 배포가 담을 자재를 배포와 «같은 함수»로 재고 단위까지 낸다.
 * 저장하지 않는다. 담을 BOM 행·소요식·환산이 배포(`releasePlan` · `releaseMaterials`)와 같아야 화면이 본 수량으로 배포된다.
 */
export async function releaseMaterialPreview(
  prisma: PrismaService,
  workOrderId: number,
): Promise<{ items: WorkOrderMaterialRequirement[] }> {
  const row = await prisma.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: {
      order_qty: true,
      production_line_id: true,
      routing_operation_id: true,
      work_order_type_code: true,
      production_plan: {
        select: {
          bom_id: true,
          bom: { select: { base_qty: true } },
          created_automatically: true,
          production_order: { select: { plant: { select: { timezone_code: true } } } },
        },
      },
    },
  });
  if (row === null) throw new NotFoundException('없는 MES W/O 입니다.');
  const plan = row.production_plan;
  if (plan === null) throw one(field('productionPlanId', ERROR_CODE.REQUIRED, '공장을 풀 계획이 없습니다(문의 040).'));

  const components = await bomComponents(prisma, row, plan.bom_id);
  const required = materialRequirements(components, row.order_qty, plan.bom.base_qty);
  const table = await loadStockUomTable(prisma, required.map((line) => line.item_id), localDate(new Date(), plan.production_order.plant.timezone_code));
  const items = await prisma.item.findMany({
    where: { item_id: { in: required.map((line) => line.item_id) } },
    select: { item_id: true, item_code: true, item_name: true },
  });
  const itemOf = new Map(items.map((item) => [item.item_id, item]));
  const uomCode = (uomId: bigint) => table.uoms.get(uomId)?.code ?? '';
  // 라인 없이 배포하는 자동 W/O 는 확인할 사람이 없어 배포가 단위 확인을 건너뛴다(`releasePlan` 의 lineless) — 같게 낸다.
  // 그 배포가 출고요청에 담는 것은 이 행이 아니라 BOM 끝 자재다(출발 창고 정책이 있을 때 · `leafRequirements`).
  const confirms = !(plan.created_automatically && row.production_line_id === null);
  return {
    items: stockUomLines(table, required).map(({ line, bomQty, conversion }) => ({
      bomComponentId: Number(line.bom_component_id),
      itemId: Number(line.item_id),
      itemCode: itemOf.get(line.item_id)?.item_code ?? '',
      itemName: itemOf.get(line.item_id)?.item_name ?? '',
      bomQty: bomQty.toNumber(),
      bomUomId: Number(conversion.bomUomId),
      bomUomCode: uomCode(conversion.bomUomId),
      stockUomId: Number(conversion.stockUomId),
      stockUomCode: uomCode(conversion.stockUomId),
      stockUomScale: table.uoms.get(conversion.stockUomId)?.scale ?? 0,
      stockQty: conversion.stockQty?.toNumber() ?? null,
      conversionSource: conversion.source,
      conversionRate: conversion.rate?.toNumber() ?? null,
      confirmationRequired: confirms && conversion.source !== null,
    })),
  };
}
