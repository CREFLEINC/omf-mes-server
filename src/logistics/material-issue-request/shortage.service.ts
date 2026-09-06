import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { BOM_COMPONENT_SELECT, MaterialIssueLine, materialRequirements } from '../../core/bom';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `MaterialIssueShortageLine` — 매퍼가 정본이다(`work-order-view.ts` 관행). */
export type MaterialIssueShortageLine = ReturnType<typeof shortageLines>[number];

/** ⓐ 축 — `bom.base_qty` 까지 한 번에 읽는다. */
const PLAN_SELECT = { select: { bom_id: true, bom: { select: { base_qty: true } } } };

/**
 * `GET …/material-issue-requests/shortage` — 한 W/O 의 품목별 소요·기출고·부족. 화면
 * `W-02-10` §3 ② 의 표를 이 한 호출이 채운다(계약 L-2 — 화면이 BOM 을 따로 안 읽는다).
 * 축 셋(I-8.md §7 · R-18~R-20):
 * ⓐ BOM = `work_order → production_plan.bom_id` 와 그 `bom.base_qty` **하나**다 — 선발행 LOT
 *   의 스냅샷으로 가면 미배포 W/O 에서 소요를 못 내므로 폴백 없이 축을 고정한다(§7-2).
 *   ⚠ 배포 뒤 계획의 BOM 이 **바뀌면**(`ProductionPlanUpdate.bomId` 실재) 이 값이 선발행
 *   스냅샷과 갈린다 — 갈리는 폭은 I-24 가 안다(「알려둘 것」 ⓓ).
 * ⓑ 기출고 = 출고 **헤더** 축이다(R-18) — 라인 축(`goods_issue_line.picking_line_id`)은 계약이
 *   그 칸을 선택으로 두어 새고 인덱스도 헤더 쪽에만 있다(`ix_goods_issue_source`).
 *   ⛔ `material_issue_request_line.issued_qty` 는 안 쓴다 — 올리는 오퍼레이션이 0건이다(046).
 * ⓒ 부족 = `max(소요 − 기출고, 0)`(계약 ⌜음수면 0 으로 낸다⌝).
 * ⛔ `skipsMaterialIssue`·`default_wip_location_id` 판정은 안 건다 — 그 둘은 배포의 «자동
 *   발행» 조건이고, 이 화면은 긴급 W/O 도 검색해 요청을 만든다.
 */
@Injectable()
export class MaterialIssueShortageService {
  constructor(private readonly prisma: PrismaService) {}

  async shortage(query: { workOrderId?: unknown }): Promise<{ items: MaterialIssueShortageLine[] }> {
    // 필수·정수 판정은 계약 검증 가드가 이미 했다(`contract-validator.ts` — 400 REQUIRED).
    const workOrderId = Number(query.workOrderId);
    const row = await this.prisma.work_order.findUnique({
      where: { work_order_id: workOrderId },
      select: { order_qty: true, routing_operation_id: true, production_plan: PLAN_SELECT },
    });
    // ⛔ 404 가 아니라 400 이다 — 계약이 이 경로에 404 를 선언하지 않았다(§7-4).
    if (row === null || row.production_plan === null) {
      throw one(field('workOrderId', ERROR_CODE.INVALID, 'BOM 을 풀 계획이 없는 작업지시입니다.'));
    }
    const plan = row.production_plan;

    // `release-plan.ts:104` 와 **같은 where** — `routing_operation_id IS NULL` 인 라인은 담지
    // 않는다(「공정 미지정 = 전 공정 공통」은 우리가 지어내는 뜻이다 · 문의 037).
    const components = await this.prisma.bom_component.findMany({
      where: { bom_id: plan.bom_id, routing_operation_id: row.routing_operation_id },
      select: BOM_COMPONENT_SELECT,
      orderBy: { sequence_no: 'asc' },
    });
    const required = materialRequirements(components, row.order_qty, plan.bom.base_qty);
    return { items: shortageLines(required, await this.issuedByItem(workOrderId)) };
  }

  /** 품목별 기출고 합 — FK 가 없는 다형 조인이라 Prisma `where` 로 못 쓴다. */
  private async issuedByItem(workOrderId: number): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.$queryRaw<{ item_id: bigint; issued_qty: Prisma.Decimal }[]>`
      SELECT gil.item_id AS item_id, SUM(gil.issue_qty) AS issued_qty
        FROM logistics.goods_issue_line gil
        JOIN logistics.goods_issue gi ON gi.goods_issue_id = gil.goods_issue_id
         AND gi.status_code = 'POSTED' AND gi.source_document_type_code = 'PICKING_ORDER'
        JOIN logistics.picking_order po ON po.picking_order_id = gi.source_document_id
         AND po.source_document_type_code = 'MATERIAL_ISSUE_REQUEST'
        JOIN logistics.material_issue_request mir
          ON mir.material_issue_request_id = po.source_document_id
       WHERE mir.work_order_id = ${BigInt(workOrderId)}
       GROUP BY gil.item_id`;
    return new Map(rows.map((row) => [String(row.item_id), row.issued_qty]));
  }
}

interface MergedItem {
  itemId: number;
  bomComponentId: number | null;
  uomId: number;
  qty: Prisma.Decimal;
}

/**
 * BOM 라인을 **품목으로 합친다**(계약 「품목별 소요·기출고·부족」). 입력이 `sequence_no`
 * 오름차순이라 처음 나온 순서가 곧 「합친 뒤 최소 `sequence_no`」다. `bomComponentId` 는
 * 라인이 하나일 때만 채우고 둘 이상이면 **널**이다(R-20).
 */
export function shortageLines(required: MaterialIssueLine[], issued: Map<string, Prisma.Decimal>) {
  const merged = new Map<string, MergedItem>();
  for (const line of required) {
    const seen = merged.get(String(line.item_id));
    if (seen === undefined) {
      merged.set(String(line.item_id), {
        itemId: Number(line.item_id),
        bomComponentId: Number(line.bom_component_id),
        uomId: Number(line.uom_id),
        qty: line.requested_qty,
      });
      continue;
    }
    seen.qty = seen.qty.plus(line.requested_qty);
    seen.bomComponentId = null;
  }
  return [...merged].map(([key, { qty, ...item }]) => {
    const issuedQty = issued.get(key) ?? new Prisma.Decimal(0);
    const shortage = qty.minus(issuedQty);
    return {
      ...item,
      requiredQty: qty.toNumber(),
      issuedQty: issuedQty.toNumber(),
      shortageQty: shortage.isNegative() ? 0 : shortage.toNumber(),
    };
  });
}
