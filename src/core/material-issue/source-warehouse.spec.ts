import { Prisma } from '@prisma/client';

import { SourceCandidate, chooseSources, pickSource, resolveCandidates } from './source-warehouse';

const d = (value: number) => new Prisma.Decimal(value);
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

function candidate(warehouseId: bigint, code: string, available: number, planned = 0, lotDate = '2026-10-01'): SourceCandidate {
  return {
    warehouseId,
    warehouseCode: code,
    availableQty: d(available),
    plannedQty: d(planned),
    earliest: { lotId: warehouseId * 100n, locationId: 1n, expiryDate: null, lotCreatedAt: at(lotDate) },
  };
}

/** 창고 A(1)·B(2), 품목 X(10)·Y(11). 잔액 행 = [창고, 품목, 가용, LOT 생성일, 유효기한]. */
function fakeTx(balances: [bigint, bigint, number, string, string | null][], planned: [bigint, bigint, number][] = [], fefo: bigint[] = []) {
  const lock = jest.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: lock,
    inventory_balance: {
      findMany: jest.fn().mockResolvedValue(
        balances.map(([w, i, qty, created, expiry], index) => ({
          warehouse_id: w,
          item_id: i,
          available_qty: d(qty),
          lot_id: BigInt(index + 1),
          location_id: 1n,
          lot: { created_at: at(created), expiry_date: expiry === null ? null : at(expiry) },
        })),
      ),
    },
    material_issue_request_line: {
      findMany: jest.fn().mockResolvedValue(
        planned.map(([w, i, qty], index) => ({
          material_issue_request_line_id: BigInt(index + 1),
          item_id: i,
          requested_qty: d(qty),
          material_issue_request: { material_issue_request_id: BigInt(index + 1), source_warehouse_id: w, issue_work_date: null },
          picking_line: [],
        })),
      ),
    },
    warehouse: {
      findMany: jest.fn().mockResolvedValue([
        { warehouse_id: 1n, warehouse_code: 'PW-A' },
        { warehouse_id: 2n, warehouse_code: 'PW-B' },
      ]),
    },
    item: { findMany: jest.fn().mockResolvedValue(fefo.map((item_id) => ({ item_id }))) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, lock };
}

describe('출발 생산 창고 고르기', () => {
  it('US2-1 창고가 하나이고 재고가 있으면 그 창고다', () => {
    expect(pickSource([candidate(1n, 'PW-A', 5)], false)?.warehouseId).toBe(1n);
  });

  it('US2-2 자재마다 한 곳에만 재고 → 자재마다 그 창고, 요청이 창고별로 갈린다', async () => {
    const { tx } = fakeTx([
      [1n, 10n, 100, '2026-10-01', null],
      [2n, 11n, 60, '2026-10-01', null],
    ]);
    const result = await chooseSources(tx, { warehouseIds: [1n, 2n], itemIds: [10n, 11n] });
    expect(result.chosen.get(10n)?.warehouseId).toBe(1n);
    expect(result.chosen.get(11n)?.warehouseId).toBe(2n);
    expect(result.unsourced).toEqual([]);
  });

  it('US2-4 둘 다 재고 → 쓸 수 있는 양(가용 − 예정)이 큰 창고(A 30 · B 80 → B)', () => {
    expect(pickSource([candidate(1n, 'PW-A', 30), candidate(2n, 'PW-B', 80)], false)?.warehouseId).toBe(2n);
    // 가용은 A 가 커도 예정을 빼면 B 가 크다.
    expect(pickSource([candidate(1n, 'PW-A', 100, 90), candidate(2n, 'PW-B', 50)], false)?.warehouseId).toBe(2n);
  });

  it('US2-10 쓸 수 있는 양이 같으면 가장 이른 LOT(선입선출) → 그래도 같으면 창고 코드', () => {
    expect(
      pickSource([candidate(1n, 'PW-A', 50, 0, '2026-10-05'), candidate(2n, 'PW-B', 50, 0, '2026-10-01')], false)?.warehouseId,
    ).toBe(2n);
    const same = [candidate(2n, 'PW-B', 50), candidate(1n, 'PW-A', 50)];
    same[0].earliest = { ...same[1].earliest };
    expect(pickSource(same, false)?.warehouseId).toBe(1n);
  });

  it('US2-10 유효기한 관리 자재는 가장 이른 유효기한이 먼저다', async () => {
    const { tx } = fakeTx(
      [
        [1n, 10n, 50, '2026-09-01', '2027-03-01'],
        [2n, 10n, 50, '2026-10-01', '2027-01-01'],
      ],
      [],
      [10n],
    );
    const result = await chooseSources(tx, { warehouseIds: [1n, 2n], itemIds: [10n] });
    expect(result.chosen.get(10n)?.warehouseId).toBe(2n);
  });

  it('US2-11 가용은 있으나 예정이 다 잡았으면 그 창고이고 쓸 수 있는 양은 0', async () => {
    const { tx } = fakeTx([[1n, 10n, 50, '2026-10-01', null]], [[1n, 10n, 50]]);
    const result = await chooseSources(tx, { warehouseIds: [1n, 2n], itemIds: [10n] });
    expect(result.chosen.get(10n)).toEqual({ warehouseId: 1n, freeQty: d(0) });
  });

  it('US2-9 후보가 없으면(재고 0 · 보류·불량만 · 연결 밖 창고) 미배정 목록이다', async () => {
    // 잔액은 집을 수 있는 것만 읽는다(PICKABLE_BALANCE) — 보류·불량·연결 밖 창고는 여기 오지 않는다.
    const { tx } = fakeTx([[1n, 10n, 30, '2026-10-01', null]]);
    const result = await chooseSources(tx, { warehouseIds: [1n, 2n], itemIds: [10n, 11n] });
    expect(result.unsourced).toEqual([11n]);
    expect(pickSource([candidate(1n, 'PW-A', 0)], false)).toBeNull();
  });

  it('같은 자재 줄이 여럿이어도 자재 단위로 한 번 고르고, 모든 (창고, 자재) 쌍을 정렬해 잠근다', async () => {
    const { tx, lock } = fakeTx([[1n, 10n, 30, '2026-10-01', null]]);
    const result = await chooseSources(tx, { warehouseIds: [2n, 1n], itemIds: [10n, 10n] });
    expect([...result.chosen.keys()]).toEqual([10n]);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.calls[0][1]).toEqual(['mir:1:10', 'mir:2:10']);
  });

  describe('US2-5 후보 집합 D·입고지 — 빠진 기준정보를 모은다', () => {
    function lineDb(line: { department_id: bigint | null; default_wip_location_id: bigint | null } | null, links: bigint[]) {
      const findLinks = jest.fn().mockResolvedValue(links.map((warehouse_id) => ({ warehouse_id })));
      const db = {
        production_line: { findUnique: jest.fn().mockResolvedValue(line) },
        department_production_warehouse: { findMany: findLinks },
      } as unknown as Prisma.TransactionClient;
      return { db, findLinks };
    }

    it('라인 부서 없음 · 생산 현장 위치 없음을 함께 낸다', async () => {
      const { db } = lineDb({ department_id: null, default_wip_location_id: null }, []);
      const result = await resolveCandidates(db, { plantId: 1n, productionLineId: 5n });
      expect('errors' in result && result.errors.map((e) => e.code)).toEqual([
        'LINE_DEPARTMENT_MISSING',
        'PRODUCTION_FLOOR_LOCATION_MISSING',
      ]);
    });

    it('부서에 이 공장의 활성 생산 창고가 없으면 PRODUCTION_WAREHOUSE_MISSING — 다른 공장 창고는 후보가 아니다', async () => {
      const { db, findLinks } = lineDb({ department_id: 7n, default_wip_location_id: 40n }, []);
      const result = await resolveCandidates(db, { plantId: 1n, productionLineId: 5n });
      expect('errors' in result && result.errors.map((e) => e.code)).toEqual(['PRODUCTION_WAREHOUSE_MISSING']);
      expect(findLinks.mock.calls[0][0].where).toEqual({
        department_id: 7n,
        warehouse: { plant_id: 1n, is_active: true },
      });
    });

    it('다 있으면 D 와 라인 생산 현장을 낸다', async () => {
      const { db } = lineDb({ department_id: 7n, default_wip_location_id: 40n }, [1n, 2n]);
      expect(await resolveCandidates(db, { plantId: 1n, productionLineId: 5n })).toEqual({
        warehouseIds: [1n, 2n],
        destinationLocationId: 40n,
      });
    });
  });
});
