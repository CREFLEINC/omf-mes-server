import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { LockedBalanceRow, lockBalancesByItemLot, lockBalancesInOrder } from './balance-lock';
import { InventoryPostingService } from './inventory-posting.service';
import { BalanceDimension, PickMove, ReserveMove } from './reservation-qty';

const RESERVATION = 7n;
/** ⭐ 예약 id 와 «다른» 값이라야 「돌려주는 id 의 출처」 변이가 죽는다(README §6-3 ⑴). */
const BALANCE = 1n;
const PICK_FIELD = 'lines[0].pickedQty';
const ISSUE_FIELD = 'lines[0].issueQty';
const RESERVE_FIELD = 'pickedQty';

const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

const dimension = (over: Partial<BalanceDimension> = {}): BalanceDimension => ({
  legalEntityId: 1n,
  businessUnitId: 2n,
  plantId: 3n,
  warehouseId: 10n,
  locationId: 20n,
  itemId: 30n,
  lotId: 40n,
  qualityStatusCode: 'NORMAL',
  inventoryStatusCode: 'AVAILABLE',
  ownershipTypeCode: 'OWNED',
  ownerPartnerId: null,
  ...over,
});

const pickMove = (over: Partial<PickMove> = {}): PickMove => ({
  dimension: dimension(),
  delta: dec(30),
  inventoryReservationId: null,
  field: PICK_FIELD,
  ...over,
});

const reserveMove = (over: Partial<ReserveMove> = {}): ReserveMove => ({
  dimension: dimension(),
  qty: dec(30),
  reservationNo: 'RS-20260909-0001',
  reservationTypeCode: 'SHIPMENT',
  sourceDocumentTypeCode: 'SHIPMENT_REQUEST_LINE',
  sourceDocumentId: 500n,
  uomId: 60n,
  statusCode: 'REGISTERED',
  createdBy: 70n,
  field: RESERVE_FIELD,
  ...over,
});

type SqlFragment = { strings: readonly string[]; values: unknown[] };
type Statement = { sql: string; values: unknown[] };

const isFragment = (value: unknown): value is SqlFragment =>
  typeof value === 'object' && value !== null && Array.isArray((value as SqlFragment).strings);

/** 중첩된 `Prisma.sql` 조각까지 펴서 문장 «전체»를 본다 — 하한 검사가 그 조각 안에 있다. */
function flatten(strings: readonly string[], values: unknown[]): Statement {
  let sql = '';
  const flat: unknown[] = [];
  strings.forEach((part, index) => {
    sql += part;
    if (index >= values.length) return;
    const value = values[index];
    if (isFragment(value)) {
      const nested = flatten(value.strings, value.values);
      sql += nested.sql;
      flat.push(...nested.values);
      return;
    }
    sql += '?';
    flat.push(value);
  });
  return { sql, values: flat };
}

/**
 * `$queryRaw` 가 돌려주는 **행 수**로 하한 통과(1행)와 위반(0행)을 흉내낸다 —
 * 판정이 WHERE 에 실려 있어서 이 코어에는 그 밖의 갈림이 없다.
 */
function fake(rowCounts: number[] = [], reservationIds: bigint[] = []) {
  const statements: Statement[] = [];
  const queue = [...rowCounts];
  const ids = [...reservationIds];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = flatten(strings, values);
      statements.push(statement);
      // 예약 표를 건드리는 문장에만 id 를 순서대로 물린다 — 「준 순서대로 돌려준다」를 관측하려면
      // 예약마다 값이 «달라야» 한다(README §6-3 ⑵).
      const reservationId = statement.sql.includes('inventory.inventory_reservation')
        ? (ids.shift() ?? RESERVATION)
        : RESERVATION;
      return Array.from({ length: queue.shift() ?? 1 }, () => ({
        inventory_balance_id: BALANCE,
        inventory_reservation_id: reservationId,
      }));
    },
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    statements,
    service: new InventoryPostingService(),
  };
}

const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

/** 잠금 함수는 «돌려주는 행»이 관측 대상이라 행 자체를 물린다. */
function lockFake(rows: Partial<LockedBalanceRow>[]) {
  const statements: Statement[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(flatten(strings, values));
      return rows;
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements };
}

describe('InventoryPostingService.reserve', () => {
  it('잔액의 reserved 를 올리고 on_hand 는 안 건드린다', async () => {
    const { tx, statements, service } = fake();

    await service.reserve(tx, [reserveMove()]);

    expect(statements[0].sql).toMatch(/UPDATE inventory\.inventory_balance$/m);
    expect(statements[0].sql).toContain('reserved_qty = reserved_qty + ?::numeric');
    expect(statements[0].sql).toMatch(/version_no = version_no \+ 1$/m);
    expect(statements[0].sql).not.toContain('on_hand_qty');
    expect(statements[0].sql).not.toContain('picked_qty');
    // ⛔ 코어는 잠그지 않는다 — 호출자가 `lockBalancesByItemLot()` 로 이미 잠근 행을 UPDATE 한다.
    expect(statements.map((statement) => statement.sql).join(' ')).not.toContain('FOR UPDATE');
  });

  it('inventory_reservation 행을 만들고 그 id 를 돌려준다', async () => {
    const { tx, statements, service } = fake();

    const ids = await service.reserve(tx, [reserveMove()]);

    // 돌려주는 것은 «예약» id 다 — 잔액 id(BALANCE) 로 바꾸면 여기서 죽는다.
    expect(ids).toEqual([RESERVATION]);
    expect(ids).not.toEqual([BALANCE]);
    // 잔액 먼저·예약 나중 — 순서를 뒤집으면 `pick()` 이 잡는 순서와 갈린다(§6-4).
    expect(statements).toHaveLength(2);
    // ⛔ `toContain` 은 접두 일치라 `…_reservation_x` 도 통과한다 — 줄 끝까지 못박는다.
    expect(statements[1].sql).toMatch(/INSERT INTO inventory\.inventory_reservation$/m);
    expect(statements[1].sql).toMatch(/RETURNING inventory_reservation_id$/m);
    // ⛔ «칸 이름» 목록도 못박는다 — 값만 보면 칸 쪽 뒤바꿈(`warehouse_id`↔`location_id` ·
    // `item_id`↔`lot_id`)에 값 배열이 «한 글자도» 안 변해 통과한다. 그 넷이 예약이 담는 차원의 전부다.
    expect(statements[1].sql).toContain(
      '(reservation_no, reservation_type_code, source_document_type_code, source_document_id,',
    );
    expect(statements[1].sql).toContain(
      'item_id, lot_id, warehouse_id, location_id, reserved_qty, uom_id, status_code, created_by)',
    );
    // 결정 — 통보 196: 11칸 중 «넷»만 담긴다. 나머지 일곱은 예약이 못 싣는다.
    expect(statements[1].values).toEqual([
      'RS-20260909-0001',
      'SHIPMENT',
      'SHIPMENT_REQUEST_LINE',
      500n,
      30n,
      40n,
      10n,
      20n,
      dec(30),
      60n,
      'REGISTERED',
      70n,
    ]);
  });

  it('11칸 차원을 그대로 겨냥한다 — 위치가 하나만 달라도 0행이다', async () => {
    const { tx, statements, service } = fake([0]);

    const failure = await thrown(() =>
      service.reserve(tx, [reserveMove({ dimension: dimension({ locationId: 99n }) })]),
    );

    // `consume` 의 같은 시험(:604)과 한 모양이다 — 11칸을 그대로 겨냥하므로 한 칸만 달라도 0행이다.
    expect(failure.getStatus()).toBe(400);
    expect(statements[0].sql).toContain('location_id = ?');
    expect(statements[0].values).toContain(99n);
  });

  it('WHERE 는 Δ + 11칸 + 가용 하한 열셋이다 — 한 칸이라도 빠지면 다른 창고 행까지 묶인다', async () => {
    const { tx, statements, service } = fake();

    await service.reserve(tx, [reserveMove()]);

    // ⛔ 차원이 통째로 빠지면(예: `item_id` 만 겨냥) 같은 LOT 의 «다른 창고» 행이 함께 UPDATE 되고
    // `balance.length === 0` 은 2행이라 지나간다 — 예약은 한 건만 서서 그 수량이 풀 근거 없이 묶인다.
    expect(statements[0].values).toEqual([
      dec(30), 1n, 2n, 3n, 10n, 20n, 30n, 40n, 'NORMAL', 'AVAILABLE', 'OWNED', null, dec(30),
    ]);
  });

  it('available_qty 와 «같은» 양은 통과한다', async () => {
    const { tx, statements, service } = fake();

    await service.reserve(tx, [reserveMove()]);

    // `>` 로 바꾸면 「가용과 같은 양」이 막힌다 — 경계가 통과 쪽이다.
    expect(statements[0].sql).toMatch(/available_qty >= \?::numeric/);
    expect(statements[0].sql).not.toMatch(/available_qty > \?/);
    expect(statements[0].values.at(-1)).toEqual(dec(30));
  });

  it('available_qty 보다 많으면 400 NEGATIVE_BALANCE', async () => {
    const { tx, service } = fake([0]);

    const failure = await thrown(() => service.reserve(tx, [reserveMove({ qty: dec(999) })]));

    expect(failure.getStatus()).toBe(400);
    // 호출자가 준 field 경로를 그대로 싣는다.
    expect(failure.errors[0]).toMatchObject({
      scope: 'field',
      field: RESERVE_FIELD,
      code: ERROR_CODE.NEGATIVE_BALANCE,
    });
  });

  it('잔액 행이 없으면 400 NEGATIVE_BALANCE (0 행을 만들지 않는다)', async () => {
    const { tx, statements, service } = fake([0]);

    const failure = await thrown(() => service.reserve(tx, [reserveMove()]));

    expect(failure.getStatus()).toBe(400);
    // `move()` 와 달리 없는 자리에 0 인 행을 세우지 않는다 — 「재고가 없다」가 「0 이 있다」가 된다.
    expect(statements[0].sql).not.toContain('INSERT INTO inventory.inventory_balance');
    // 잔액이 0행이면 예약 INSERT 는 아예 안 나간다 — 번호만 타고 행이 남으면 안 된다.
    expect(statements).toHaveLength(1);
  });

  it('qty 가 0 이면 아무것도 하지 않는다 (version_no 도 안 올린다)', async () => {
    const { tx, statements, service } = fake();

    const ids = await service.reserve(tx, [
      reserveMove({ qty: dec(0) }),
      reserveMove({ qty: dec('0.000000') }),
    ]);

    expect(statements).toEqual([]);
    // 걸지 않았으므로 돌려줄 id 도 없다 — 그 자리가 배열에서 빠진다.
    expect(ids).toEqual([]);
  });

  it('Decimal 로 센다: 0.1 + 0.2 를 부동소수로 세지 않는다', async () => {
    const { tx, statements, service } = fake();

    await service.reserve(tx, [reserveMove({ qty: dec('0.1').plus(dec('0.2')) })]);

    expect(0.1 + 0.2).not.toBe(0.3);
    expect(String(statements[0].values[0])).toBe('0.3');
    expect(String(statements[1].values[8])).toBe('0.3');
  });

  it('moves 여럿을 준 순서대로 예약 id 를 돌려준다', async () => {
    const { tx, statements, service } = fake([], [71n, 72n]);

    const ids = await service.reserve(tx, [
      reserveMove({ reservationNo: 'RS-20260909-0001', qty: dec(1) }),
      reserveMove({ reservationNo: 'RS-20260909-0002', qty: dec(2) }),
    ]);

    expect(ids).toEqual([71n, 72n]);
    expect(statements).toHaveLength(4);
    expect(statements[1].values[0]).toBe('RS-20260909-0001');
    expect(statements[3].values[0]).toBe('RS-20260909-0002');
  });

  it('reservationNo 가 중복이면 유일 위반을 그대로 올린다', async () => {
    const unique = new Error('duplicate key value violates unique constraint');
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (flatten(strings, values).sql.includes('INSERT INTO inventory.inventory_reservation')) {
          throw unique;
        }
        return [{ inventory_balance_id: BALANCE }];
      },
    } as unknown as Prisma.TransactionClient;

    // ⛔ 삼켜서 400 으로 바꾸지 않는다 — 같은 번호가 둘이면 채번이 깨진 것이라 500 이 맞다.
    await expect(new InventoryPostingService().reserve(tx, [reserveMove()])).rejects.toBe(unique);
  });

  it('reserve 가 만든 예약을 pick 이 그대로 물어 곧바로 푼다', async () => {
    const { tx, statements, service } = fake();

    const [reservationId] = await service.reserve(tx, [reserveMove()]);
    await service.pick(tx, [pickMove({ inventoryReservationId: reservationId })]);

    // ⓒ안 — 걸고 «곧바로» 푼다. reserved 는 올랐다가 같은 양 내려가고 picked 만 남는다.
    expect(statements[0].sql).toContain('reserved_qty = reserved_qty + ?::numeric');
    expect(statements[2].sql).toContain('reserved_qty = reserved_qty - ?::numeric');
    expect(statements[2].sql).toContain('picked_qty = picked_qty + ?::numeric');
    // ⛔ 「reserved 순변화 0」은 코어가 아니라 «호출자»의 성질이라 이 층에서 못 잠근다 — 두 Δ 가 같은지
    // 재면 픽스처끼리 재는 것이라 소스 어떤 변이로도 안 죽는다. R-2(ⓒ안)의 실관측점은 PR ⑥ e2e 다:
    // `:pick` 뒤 그 잔액 행의 `reserved_qty` 불변 · `picked_qty` +Δ · 예약의 `consumed_qty = reserved_qty`.
    // 푸는 쪽이 «방금 만든» 예약을 물어야 예약이 열린 채 남지 않는다(결정 — 통보 196).
    expect(statements[3].sql).toMatch(/UPDATE inventory\.inventory_reservation$/m);
    expect(statements[3].sql).toContain('consumed_qty = consumed_qty + ?::numeric');
    expect(statements[3].values).toContain(RESERVATION);
  });
});

describe('lockBalancesByItemLot', () => {
  const row = (over: Partial<LockedBalanceRow> = {}): Partial<LockedBalanceRow> => ({
    warehouseId: 10n,
    locationId: 20n,
    itemId: 30n,
    lotId: 40n,
    available_qty: dec(100),
    ...over,
  });

  it('(품목·LOT)의 행 전부를 id 오름차순으로 돌려준다', async () => {
    // ⭐ 창고가 «둘»인 픽스처다 — 한 행뿐이면 「전부 돌려준다」도 「첫 개만」도 똑같이 초록이다.
    const rows = [row({ warehouseId: 10n }), row({ warehouseId: 11n })];
    const { tx, statements } = lockFake(rows);

    const locked = await lockBalancesByItemLot(tx, 30n, 40n);

    expect(locked).toEqual(rows);
    expect(locked).toHaveLength(2);
    expect(statements[0].sql).toContain('item_id = ?');
    expect(statements[0].sql).toContain('lot_id = ?');
    expect(statements[0].values).toEqual([30n, 40n]);
    // 형제(`lockBalancesInOrder`)와 «같은» 순서라야 교착 창이 안 열린다.
    expect(statements[0].sql).toMatch(/ORDER BY inventory_balance_id$/m);
    expect(statements[0].sql).not.toContain('DESC');
    // ⛔ 줄 끝까지 못박는다 — `toContain('FOR UPDATE')` 는 `SKIP LOCKED`·`NOWAIT` 를 통과시키고,
    // `SKIP LOCKED` 는 «다른 트랜잭션이 쥔» 잔액 행을 조용히 빼서 2행을 1행처럼 보이게 한다.
    expect(statements[0].sql).toMatch(/FOR UPDATE$/m);
  });

  it('형제 lockBalancesInOrder 와 «같은» 칸을 돌려준다', async () => {
    const { tx, statements } = lockFake([]);

    await lockBalancesByItemLot(tx, 30n, 40n);
    await lockBalancesInOrder(tx, [
      {
        legalEntityId: 1n,
        businessUnitId: 2n,
        plantId: 3n,
        warehouseId: 10n,
        locationId: 20n,
        itemId: 30n,
        lotKey: 40n,
      },
    ]);

    // 둘 다 `LockedBalanceRow` 를 낸다 — 한쪽 칸을 지우거나 상수로 덮으면 여기서 갈린다.
    // (`toContain('available_qty')` 는 `0 AS available_qty` 도 통과해 공허했다.)
    const projection = (sql: string): string =>
      sql.split('FROM inventory.inventory_balance')[0].replace(/\s+/g, ' ').trim();
    expect(projection(statements[0].sql)).toBe(projection(statements[1].sql));
    // 잠근 행을 그대로 `reserve()`·`pick()` 에 넘기므로 하한 판정 칸이 실려 있어야 한다.
    expect(projection(statements[0].sql)).toContain('owner_partner_id, available_qty');
  });

  it('없으면 빈 배열이다 (행을 만들지 않는다)', async () => {
    const { tx, statements } = lockFake([]);

    const locked = await lockBalancesByItemLot(tx, 30n, 40n);

    // 0행의 «뜻»(409)은 호출자가 정한다 — 코어는 잠글 뿐 판정하지 않는다.
    expect(locked).toEqual([]);
    expect(statements[0].sql).not.toContain('INSERT');
  });
});

describe('InventoryPostingService.pick', () => {
  it('예약이 있으면 reserved 를 내리고 picked 를 같은 양 올린다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove({ inventoryReservationId: RESERVATION })]);

    expect(statements[0].sql).toContain('UPDATE inventory.inventory_balance');
    expect(statements[0].sql).toContain('reserved_qty = reserved_qty - ?::numeric');
    expect(statements[0].sql).toContain('picked_qty = picked_qty + ?::numeric');
    expect(statements[0].sql).toContain('version_no = version_no + 1');
    // 합이 그대로라 `check_balance_qty()` 가 이 문장 하나로도 참이다.
    expect(statements[0].sql).toContain('reserved_qty >= ?::numeric');
    expect(statements[0].values.slice(0, 2)).toEqual([dec(30), dec(30)]);
  });

  it('예약이 있으면 inventory_reservation.consumed_qty 를 같은 양 올린다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove({ inventoryReservationId: RESERVATION })]);

    expect(statements).toHaveLength(2);
    expect(statements[1].sql).toContain('UPDATE inventory.inventory_reservation');
    expect(statements[1].sql).toContain('consumed_qty = consumed_qty + ?::numeric');
    expect(statements[1].sql).toContain('inventory_reservation_id = ?');
    expect(statements[1].sql).toContain('item_id = ?::bigint');
    expect(statements[1].values).toContainEqual(dec(30));
    expect(statements[1].values).toContain(RESERVATION);
    expect(statements[1].values).toContain(30n);
  });

  it('LOT 없는 잔액(lotId null)은 COALESCE 로 겨냥하고 null 을 바인딩한다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove({ dimension: dimension({ lotId: null }) })]);

    expect(statements[0].sql).toContain('COALESCE(lot_id, 0::bigint) = COALESCE(?::bigint, 0::bigint)');
    expect(statements[0].values).toContain(null);
  });

  it('코어는 잠그지 않는다 — FOR UPDATE 를 내지 않는다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove({ inventoryReservationId: RESERVATION })]);
    await service.consume(tx, [{ dimension: dimension(), qty: dec(1), field: 'lines[0].lotId' }]);

    expect(statements.map((s) => s.sql).join(' ')).not.toContain('FOR UPDATE');
  });

  it('예약이 없으면 available 에서 picked 로 올린다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove()]);

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('available_qty >= ?::numeric');
    expect(statements[0].sql).not.toContain('reserved_qty = reserved_qty');
  });

  it('Δ 가 0 이면 잔액도 예약도 version_no 도 건드리지 않는다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [
      pickMove({ delta: dec(0), inventoryReservationId: RESERVATION }),
      pickMove({ delta: dec('0.000000'), inventoryReservationId: null }),
    ]);

    expect(statements).toEqual([]);
  });

  it('Δ 가 음수면 picked 를 내리고 예약을 되돌린다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove({ delta: dec(-5), inventoryReservationId: RESERVATION })]);

    // 부호 하나로 두 방향을 함께 쓴다 — `reserved_qty - (−5)` 가 되돌림이다.
    expect(statements[0].sql).toContain('reserved_qty = reserved_qty - ?::numeric');
    expect(statements[0].sql).toContain('picked_qty >= ?::numeric');
    expect(statements[0].values).toContainEqual(dec(5));
    expect(statements[1].sql).toContain('consumed_qty >= ?::numeric');
  });

  it('Δ 가 음수인데 picked_qty 가 모자라면 400 NEGATIVE_BALANCE', async () => {
    const { tx, service } = fake([0]);

    const failure = await thrown(() =>
      service.pick(tx, [pickMove({ delta: dec(-5), inventoryReservationId: RESERVATION })]),
    );

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({ code: ERROR_CODE.NEGATIVE_BALANCE });
  });

  it('예약을 되돌릴 때 consumed_qty 가 모자라면 400 NEGATIVE_BALANCE', async () => {
    // 잔액은 1행으로 통과하고 예약이 0행이다 — 하한이 빠지면 `app.qty_t` CHECK 로 500 이 된다(R-2).
    const { tx, statements, service } = fake([1, 0]);

    const failure = await thrown(() =>
      service.pick(tx, [pickMove({ delta: dec(-5), inventoryReservationId: RESERVATION })]),
    );

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({
      scope: 'field',
      field: PICK_FIELD,
      code: ERROR_CODE.NEGATIVE_BALANCE,
    });
    expect(statements[1].sql).toContain('consumed_qty >= ?::numeric');
  });

  it('available_qty 보다 많이 피킹하면 400 NEGATIVE_BALANCE (예약 없음)', async () => {
    const { tx, service } = fake([0]);

    const failure = await thrown(() => service.pick(tx, [pickMove({ delta: dec(999) })]));

    expect(failure.getStatus()).toBe(400);
    // 호출자가 준 field 경로를 그대로 싣는다 — 400 의 자리가 호출자마다 다르다.
    expect(failure.errors[0]).toMatchObject({
      scope: 'field',
      field: PICK_FIELD,
      code: ERROR_CODE.NEGATIVE_BALANCE,
    });
  });

  it('reserved_qty 보다 많이 피킹하면 400 NEGATIVE_BALANCE (예약 있음)', async () => {
    const { tx, statements, service } = fake([0]);

    const failure = await thrown(() =>
      service.pick(tx, [pickMove({ delta: dec(999), inventoryReservationId: RESERVATION })]),
    );

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({ code: ERROR_CODE.NEGATIVE_BALANCE });
    // 잔액이 0행이면 예약 문장은 아예 안 나간다.
    expect(statements).toHaveLength(1);
  });

  it('예약의 남은 양(reserved − released − consumed)보다 많으면 400 — ck_reservation_qty 를 앞당긴다', async () => {
    const { tx, statements, service } = fake([1, 0]);

    const failure = await thrown(() =>
      service.pick(tx, [pickMove({ delta: dec(30), inventoryReservationId: RESERVATION })]),
    );

    expect(failure.getStatus()).toBe(400);
    expect(statements[1].sql).toContain(
      'reserved_qty - released_qty - consumed_qty >= ?::numeric',
    );
  });

  it('잔액 행이 없으면 400 NEGATIVE_BALANCE — 0 인 행을 만들지 않는다', async () => {
    const { tx, statements, service } = fake([0]);

    const failure = await thrown(() => service.pick(tx, [pickMove()]));

    expect(failure.getStatus()).toBe(400);
    // `move()` 와 달리 「없는 자리에서 피킹할 수 없다」가 사실이라 INSERT 로 만들지 않는다.
    expect(statements.every((statement) => !statement.sql.includes('INSERT'))).toBe(true);
  });

  it('Decimal 로 센다 — 0.1 + 0.2 를 부동소수로 세지 않는다', async () => {
    const { tx, statements, service } = fake();

    await service.pick(tx, [pickMove({ delta: dec('0.1').plus(dec('0.2')) })]);

    expect(0.1 + 0.2).not.toBe(0.3);
    expect(String(statements[0].values[0])).toBe('0.3');
  });
});

describe('InventoryPostingService.consume', () => {
  const consumeMove = (over: Partial<BalanceDimension> = {}) => ({
    dimension: dimension(over),
    qty: dec(30),
    field: ISSUE_FIELD,
  });

  it('picked 를 내리고 on_hand·reserved 는 건드리지 않는다', async () => {
    const { tx, statements, service } = fake();

    await service.consume(tx, [consumeMove()]);

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('picked_qty = picked_qty - ?::numeric');
    expect(statements[0].sql).toContain('picked_qty >= ?::numeric');
    expect(statements[0].sql).not.toContain('on_hand_qty');
    expect(statements[0].sql).not.toContain('reserved_qty');
    expect(statements[0].sql).not.toContain('inventory_reservation');
  });

  it('picked_qty 가 모자라면 400 NEGATIVE_BALANCE', async () => {
    const { tx, service } = fake([0]);

    const failure = await thrown(() => service.consume(tx, [consumeMove()]));

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({
      scope: 'field',
      field: ISSUE_FIELD,
      code: ERROR_CODE.NEGATIVE_BALANCE,
    });
  });

  it('다른 차원(위치가 다른 행)에서는 소진하지 못한다', async () => {
    const { tx, statements, service } = fake([0]);

    const failure = await thrown(() =>
      service.consume(tx, [consumeMove({ locationId: 99n })]),
    );

    expect(failure.getStatus()).toBe(400);
    // 11칸을 그대로 겨냥하므로 위치가 하나만 달라도 0행이다.
    expect(statements[0].sql).toContain('location_id = ?');
    expect(statements[0].values).toContain(99n);
  });
});
