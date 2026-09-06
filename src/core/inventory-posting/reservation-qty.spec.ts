import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { InventoryPostingService } from './inventory-posting.service';
import { BalanceDimension, PickMove } from './reservation-qty';

const RESERVATION = 7n;
const PICK_FIELD = 'lines[0].pickedQty';
const ISSUE_FIELD = 'lines[0].issueQty';

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
function fake(rowCounts: number[] = []) {
  const statements: Statement[] = [];
  const queue = [...rowCounts];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(flatten(strings, values));
      return Array.from({ length: queue.shift() ?? 1 }, () => ({
        inventory_balance_id: 1n,
        inventory_reservation_id: RESERVATION,
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
    expect(statements[1].values).toContainEqual(dec(30));
    expect(statements[1].values).toContain(RESERVATION);
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
