import { Prisma } from '@prisma/client';

import { CandidateLine, chooseLine } from './shipment-lot-pick-warehouse';
import { withTerminalScope } from './shipment-request-terminal-view';
import { ShipmentRequestView } from './shipment-request-view';

const D = (value: number) => new Prisma.Decimal(value);
const A = 10n;
const B = 20n;
const C = 30n;
const line = (lineNo: number, warehouseId: bigint, allocated: number, picked = 0): CandidateLine =>
  ({ lineId: BigInt(100 + lineNo), lineNo, warehouseId, allocated: D(allocated), picked: D(picked) });

describe('chooseLine — 피처 012 R-3 줄 고르기(LOT 창고 → 줄)', () => {
  it('US2-3 LOT 이 줄 창고 A 에 있으면 그 줄', () => {
    expect(chooseLine([line(1, A, 100)], new Set([String(A)]))).toEqual({ kind: 'LINE', line: line(1, A, 100) });
  });

  it('US2-4 같은 품목 줄1(A)·줄3(C), C 의 LOT 은 줄3 — 경로의 줄과 무관하게 LOT 창고로 고른다', () => {
    const choice = chooseLine([line(1, A, 100), line(3, C, 50)], new Set([String(C)]));
    expect(choice).toMatchObject({ kind: 'LINE', line: { lineNo: 3 } });
  });

  it('US2-5·SC-002 LOT 이 줄 창고 어디에도 없으면 NOT_IN_LINE_WAREHOUSE', () => {
    expect(chooseLine([line(1, A, 100), line(3, C, 50)], new Set([String(B)]))).toEqual({ kind: 'NOT_IN_LINE_WAREHOUSE' });
    expect(chooseLine([], new Set([String(A)]))).toEqual({ kind: 'NOT_IN_LINE_WAREHOUSE' });
  });

  it('Edge 같은 품목·같은 창고 줄 둘은 남은 수량이 있는 앞 줄부터', () => {
    expect(chooseLine([line(2, A, 50), line(1, A, 100, 100)], new Set([String(A)]))).toMatchObject({ kind: 'LINE', line: { lineNo: 2 } });
    expect(chooseLine([line(2, A, 50), line(1, A, 100)], new Set([String(A)]))).toMatchObject({ kind: 'LINE', line: { lineNo: 1 } });
  });

  it('E-3·빈 곳 ⑤ 창고 맞는 줄 찾기가 먼저 — 맞는 줄이 모두 찼을 때만 TARGET_REACHED, 다른 창고 줄이 비어 있어도 거기로 가지 않는다', () => {
    const choice = chooseLine([line(1, A, 100, 120), line(2, B, 50)], new Set([String(A)]));
    expect(choice).toMatchObject({ kind: 'TARGET_REACHED', line: { lineNo: 1 } });
  });

  it('Edge-span A·C 에 걸친 LOT 은 맞는 창고 줄 하나를 고른다(잡는 몫은 그 창고만 — 서비스)', () => {
    expect(chooseLine([line(1, A, 100)], new Set([String(A), String(C)]))).toMatchObject({ kind: 'LINE', line: { lineNo: 1 } });
  });
});

describe('withTerminalScope — PDA 목록 줄 범위(FR-011 · 빈 곳 ⑥)', () => {
  const warehouse = (warehouseId: number, plantId: number) => ({ warehouseId, warehouseCode: `W${warehouseId}`, warehouseName: `창고${warehouseId}`, plantId, plantName: `공장${plantId}` });
  const view = (lines: { warehouse: ReturnType<typeof warehouse> | null }[], fulfillmentPlantId: number | null = null) =>
    ({ fulfillmentPlantId, lines: lines.map((row, index) => ({ shipmentRequestLineId: index + 1, ...row })) }) as unknown as ShipmentRequestView;

  it('US2-1·US2-2 다른 공장 창고 줄은 OTHER_PLANT 로 싣고, 피킹할 줄 수는 범위 안 줄만 센다', () => {
    const scoped = withTerminalScope(view([{ warehouse: warehouse(10, 1) }, { warehouse: warehouse(20, 2) }]), { plantId: 1n, warehouseId: null });
    expect(scoped.lines?.map((row) => [row.inTerminalScope, row.outOfScopeReason])).toEqual([[true, null], [false, 'OTHER_PLANT']]);
    expect(scoped.pickableLineCount).toBe(1);
  });

  it('US2-6 창고 지정 단말은 같은 공장 다른 창고 줄을 OTHER_WAREHOUSE 로 본다', () => {
    const scoped = withTerminalScope(view([{ warehouse: warehouse(10, 1) }, { warehouse: warehouse(30, 1) }]), { plantId: 1n, warehouseId: 10n });
    expect(scoped.lines?.map((row) => row.outOfScopeReason)).toEqual([null, 'OTHER_WAREHOUSE']);
  });

  it('US6-2 창고 없는 옛 줄은 지시서 이행 공장으로 본다', () => {
    expect(withTerminalScope(view([{ warehouse: null }], 1), { plantId: 1n, warehouseId: 10n }).pickableLineCount).toBe(1);
    expect(withTerminalScope(view([{ warehouse: null }], 1), { plantId: 2n, warehouseId: null }).lines?.[0].outOfScopeReason).toBe('OTHER_PLANT');
  });
});
