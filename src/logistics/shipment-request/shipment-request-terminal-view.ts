import { OutOfScopeReason, TerminalShipmentScope, lineInTerminalScopeSql, lineOutOfScopeReason } from './shipment-request-scope';
import { shipmentLinePickedSql } from './shipment-progress';
import { ShipmentRequestLineView, ShipmentRequestView } from './shipment-request-view';

/** PDA 목록 줄 — 이 기기 범위 안인지와 밖인 이유(피처 012 FR-011 · 빈 곳 ⑥). */
export type TerminalScopedLineView = ShipmentRequestLineView & { inTerminalScope: boolean; outOfScopeReason: OutOfScopeReason | null };

/** PDA 목록 행 — 이 기기에서 피킹할 줄 수(빈 곳 ⑥ 「다른 공장 창고 줄 n」의 근거). */
export type TerminalScopedRequestView = Omit<ShipmentRequestView, 'lines'> & {
  pickableLineCount: number;
  lines?: TerminalScopedLineView[];
};

/**
 * 단말(PDA) 목록 뷰에 줄 범위를 싣는다 — 판정은 범위 모듈 하나다. 범위 밖 줄도 싣는다(읽기 전용으로 보인다 · US2-2).
 * 창고 없는 옛 줄은 지시서 이행 공장으로 본다(FR-027).
 */
export function withTerminalScope(view: ShipmentRequestView, scope: TerminalShipmentScope): TerminalScopedRequestView {
  const lines = (view.lines ?? []).map((line) => {
    const reason = lineOutOfScopeReason({
      warehouseId: line.warehouse === null ? null : BigInt(line.warehouse.warehouseId),
      warehousePlantId: line.warehouse === null ? null : BigInt(line.warehouse.plantId),
      requestPlantId: view.fulfillmentPlantId === null ? null : BigInt(view.fulfillmentPlantId),
    }, scope);
    return { ...line, inTerminalScope: reason === null, outOfScopeReason: reason };
  });
  return { ...view, lines, pickableLineCount: lines.filter((line) => line.inTerminalScope).length };
}

/**
 * SQL — 단말 범위 안 줄 가운데 피킹이 목표에 못 미친 줄이 있다(PDA 「제품 출하 피킹」 배지 · FR-010). 지시서 별칭 `request`.
 * 다른 공장 창고 줄이 남아 있어도 이 기기 몫이 끝났으면 세지 않는다.
 */
export function requestHasOpenLineInScopeSql(request: string, scope: TerminalShipmentScope, bind: (value: unknown) => string): string {
  return `EXISTS (SELECT 1 FROM logistics.shipment_request_line ol
                 WHERE ol.shipment_request_id = ${request}.shipment_request_id
                   AND ${lineInTerminalScopeSql('ol', request, scope, bind)}
                   AND ${shipmentLinePickedSql('ol')} < ol.allocated_qty)`;
}
