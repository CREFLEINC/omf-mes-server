import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentPickService } from './shipment-pick.service';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestView } from './shipment-request-view';

/**
 * ⭐⭐ **e2e 로는 «구조적으로» 못 잡는 축**을 여기서 잠근다(README §6-3 「반증 불가 부류」).
 *
 * ⓐ **자원 고갈** — 채번을 `$transaction` «안»으로 옮기는 변이는 요청 하나짜리 e2e 를 **전건
 *    초록**으로 통과한다. 죽는 것은 커넥션 풀이 마를 때뿐(`P2024`)이고 그 조건은 기능 시험이
 *    만들지 않는다 ⇒ **호출 «순서»를 배열로 대조**한다(선례 `material-consumption.service.spec.ts:324`).
 * ⓑ **잠금 «대상»** — `FOR UPDATE OF l` 을 `FOR UPDATE` 로 바꿔도 HTTP 응답은 한 글자도 안 바뀐다.
 *    깨지는 것은 «동시»에 두 라인을 집을 때뿐이라 e2e 로는 타이밍에 기대게 된다 ⇒ SQL 문장을 본다.
 * ⓒ **응답에 안 실리는 인자** — `reserve()` 가 돌려준 예약 id 가 `pick()` 으로 «건너가는가».
 *
 * ⛔ 이 파일은 e2e 를 **대신하지 않는다** — 두 층을 같이 돌리는 것이 규칙이다(README §6-2).
 */

const LINE_ID = 501n;
const RESERVATION_ID = 9001n;
const NUMBER = 'RS-20260909-0001';

interface Recorded {
  order: string[];
  numbered: [string, bigint | null, string][];
  sql: string[];
  reserved: Record<string, unknown>[];
  picked: Record<string, unknown>[];
}

interface Overrides {
  lotPlantId?: bigint;
  balancePlantId?: bigint;
  allocatedQty?: string;
  minimumRemainingShelfLifeDays?: number | null;
  expiryDate?: Date | null;
  availableQty?: Prisma.Decimal | null;
  reservations?: { reserved_qty: Prisma.Decimal; released_qty: Prisma.Decimal }[];
  balanceRows?: number;
}

const BALANCE = {
  legalEntityId: 1n,
  businessUnitId: 2n,
  plantId: 3n,
  warehouseId: 4n,
  locationId: 5n,
  itemId: 21n,
  // ⭐ `lotKey` 와 `lotId` 를 «다른 값»으로 세운다(§6-3 ⑵). 오늘의 DB 에서는 둘이 같지만
  //   (`lockBalancesByItemLot` 이 `lot_id = ?` 로 잠근다) 같은 값이면 「어느 칸을 읽는가」가
  //   공허해진다 — 코어가 COALESCE 로 넓어지는 날 `lotKey` 는 「LOT 없음」을 0 으로 접는다.
  lotKey: 0n,
  lotId: 61n,
  quality_status_code: 'GOOD',
  inventory_status_code: 'AVAILABLE',
  ownership_type_code: 'OWNED',
  owner_partner_id: null,
  available_qty: new Prisma.Decimal(100),
};

function stub(overrides: Overrides = {}) {
  const recorded: Recorded = { order: [], numbered: [], sql: [], reserved: [], picked: [] };
  // ⛔ `??` 로 쓰면 `null` 을 「안 준 것」으로 접어 그 갈래를 영영 못 태운다.
  const balance = {
    ...BALANCE,
    plantId: overrides.balancePlantId ?? BALANCE.plantId,
    available_qty: 'availableQty' in overrides ? overrides.availableQty : BALANCE.available_qty,
  };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = [...strings].join('?');
      recorded.sql.push(sql);
      if (sql.includes('shipment_request_line')) {
        recorded.order.push('lock-line');
        return [
          {
            shipment_request_line_id: LINE_ID,
            item_id: 21n,
            uom_id: 31n,
            allocated_qty: new Prisma.Decimal(overrides.allocatedQty ?? '300'),
            minimum_remaining_shelf_life_days:
              overrides.minimumRemainingShelfLifeDays === undefined
                ? null
                : overrides.minimumRemainingShelfLifeDays,
            fulfillment_plant_id: 3n,
          },
        ];
      }
      recorded.order.push('lock-balance');
      return Array.from({ length: overrides.balanceRows ?? 1 }, () => balance);
    },
    lot: {
      findUnique: async () => {
        recorded.order.push('lot');
        return {
          lot_id: 61n,
          item_id: 21n,
          plant_id: overrides.lotPlantId ?? 3n,
          status_code: 'NORMAL',
          expiry_date: overrides.expiryDate === undefined ? null : overrides.expiryDate,
        };
      },
    },
    lot_hold: {
      findFirst: async () => {
        recorded.order.push('hold');
        return null;
      },
    },
    judgment_type_control: {
      findFirst: async () => {
        recorded.order.push('blocks-picking');
        return null;
      },
    },
    inventory_reservation: {
      findMany: async () => {
        recorded.order.push('reservations');
        return overrides.reservations ?? [];
      },
    },
    // ⛔ 있으면 «부르는» 변이가 조용히 지나간다 — 불리면 순서 배열에 남게 세워 둔다.
    shipment_request_line: {
      update: async () => {
        recorded.order.push('line-update');
        return {};
      },
    },
    shipment_request: {
      update: async () => {
        recorded.order.push('header-update');
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      recorded.order.push('transaction');
      return work(tx);
    },
  };
  const numbering = {
    next: async (type: string, plantId: bigint | null, periodDate: string) => {
      recorded.order.push('numbering');
      recorded.numbered.push([type, plantId, periodDate]);
      return NUMBER;
    },
  };
  const posting = {
    reserve: async (_client: unknown, moves: Record<string, unknown>[]) => {
      recorded.order.push('reserve');
      recorded.reserved.push(...moves);
      return [RESERVATION_ID];
    },
    pick: async (_client: unknown, moves: Record<string, unknown>[]) => {
      recorded.order.push('pick');
      recorded.picked.push(...moves);
    },
  };
  const queries = {
    get: async (id: number) => {
      recorded.order.push('readback');
      return {
        shipmentRequestId: id,
        lines: [{ shipmentRequestLineId: Number(LINE_ID), pickedQty: 30 }],
      } as unknown as ShipmentRequestView;
    },
  };
  return {
    service: new ShipmentPickService(
      prisma as unknown as PrismaService,
      posting as unknown as InventoryPostingService,
      numbering as unknown as NumberingService,
      queries as unknown as ShipmentRequestQueryService,
    ),
    recorded,
  };
}

const run = (harness: ReturnType<typeof stub>, pickedQty = 30) =>
  harness.service.pick(77, Number(LINE_ID), { lotId: 61, pickedQty, uomId: 31 }, {
    workerNo: 'W-1',
    appUserId: 3,
  });

describe('제품 LOT 피킹 — 트랜잭션 순서·잠금 대상 (§3-2)', () => {
  it('이행 공장 밖의 LOT은 예약·피킹 전에 거부한다', async () => {
    const harness = stub({ lotPlantId: 4n });
    const error = await run(harness).catch((caught: unknown) => caught);
    expect((error as { getStatus: () => number }).getStatus()).toBe(400);
    expect(harness.recorded.order).not.toContain('reserve');
    expect(harness.recorded.order).not.toContain('pick');
  });

  it('LOT은 같은 공장이더라도 잔액이 다른 공장이면 예약·피킹 전에 거부한다', async () => {
    const harness = stub({ balancePlantId: 4n });
    const error = await run(harness).catch((caught: unknown) => caught);
    expect((error as { getStatus: () => number }).getStatus()).toBe(409);
    expect(harness.recorded.order).not.toContain('reserve');
    expect(harness.recorded.order).not.toContain('pick');
  });

  it('⭐⭐ 번호를 $transaction 「밖」에서 뽑고 14단계를 계약 문장 순서로 돈다', async () => {
    const harness = stub();

    await run(harness);

    // ⛔ 안에서 부르면 한 요청이 커넥션을 둘 쥐고, 동시 요청이 풀에 이르면 `P2024` 로 죽는다.
    // ⭐ ⑦(보류) → ⑪(가용) → ⑫(배정)가 계약 문장의 순서다 — 배열이 그 순서를 통째로 잠근다.
    expect(harness.recorded.order).toEqual([
      'numbering',
      'transaction',
      'lock-line',
      'lot',
      'hold',
      'blocks-picking',
      'lock-balance',
      'reservations',
      'reserve',
      'pick',
      'readback',
    ]);
  });

  it('⭐ 채번 축이 (INVENTORY_RESERVATION · 공장 null · 서버 UTC 날짜) 다', async () => {
    const harness = stub();

    await run(harness);

    // 본문에 날짜 칸이 0개라 클라이언트가 줄 값이 없다(01 은 businessDate·occurredAt 둘 다 required).
    const today = new Date().toISOString().slice(0, 10);
    expect(harness.recorded.numbered).toEqual([['INVENTORY_RESERVATION', null, today]]);
  });

  it('⭐⭐ 라인은 배타·헤더는 공유 잠금이라 공장 지정과 피킹이 교차하지 않는다', async () => {
    const harness = stub();

    await run(harness);

    const [lockSql] = harness.recorded.sql;
    // 라인 배타 잠금은 같은 라인의 누적 피킹을 직렬화하고, 헤더 공유 잠금은 공장 변경만 막는다.
    expect(lockSql).toMatch(/FOR UPDATE OF l/);
    expect(lockSql).toMatch(/FOR SHARE OF h/);
    expect(lockSql).toMatch(/JOIN logistics\.shipment_request h/);
  });

  it('⭐⭐ reserve 가 돌려준 예약 id 가 그대로 pick 으로 건너간다 (ⓒ안)', async () => {
    const harness = stub();

    await run(harness);

    // ⛔ `null` 로 두면 예약이 열린 채 남아 `openOnly=true` 목록을 오염시킨다(e2e P-3·P-5·P-6).
    expect(harness.recorded.picked).toEqual([
      {
        dimension: harness.recorded.reserved[0].dimension,
        delta: new Prisma.Decimal(30),
        inventoryReservationId: RESERVATION_ID,
        field: 'pickedQty',
      },
    ]);
  });

  it('⭐ 예약 행의 축 — 유형·원천·단위·상태·행위자·번호가 제 출처에서 온다', async () => {
    const harness = stub();

    await run(harness);

    expect(harness.recorded.reserved).toEqual([
      {
        dimension: {
          legalEntityId: 1n,
          businessUnitId: 2n,
          plantId: 3n,
          warehouseId: 4n,
          locationId: 5n,
          itemId: 21n,
          lotId: 61n,
          qualityStatusCode: 'GOOD',
          inventoryStatusCode: 'AVAILABLE',
          ownershipTypeCode: 'OWNED',
          ownerPartnerId: null,
        },
        qty: new Prisma.Decimal(30),
        reservationNo: NUMBER,
        reservationTypeCode: 'SHIPMENT',
        sourceDocumentTypeCode: 'SHIPMENT_REQUEST_LINE',
        sourceDocumentId: LINE_ID,
        uomId: 31n,
        statusCode: 'REGISTERED',
        createdBy: 3n,
        field: 'pickedQty',
      },
    ]);
  });

  it('⭐⭐ 누적이다 — 이미 집은 것이 있어도 Δ 는 본문 값 그대로다', async () => {
    const harness = stub({
      reservations: [{ reserved_qty: new Prisma.Decimal(50), released_qty: new Prisma.Decimal(0) }],
    });

    await run(harness, 30);

    // ⛔ I-8 식 「대체」(`pickedQty.minus(line.picked_qty)`)로 짜면 Δ 가 −20 이 된다(e2e P-8).
    expect(harness.recorded.reserved[0].qty).toEqual(new Prisma.Decimal(30));
    expect(harness.recorded.picked[0].delta).toEqual(new Prisma.Decimal(30));
  });

  it('⭐ 잠근 행의 available_qty 가 널이면 0 으로 본다 — 통과시키지 않는다', async () => {
    const harness = stub({ availableQty: null });

    const caught = await run(harness).catch((error: unknown) => error);

    // `available_qty` 는 생성 컬럼이라 Prisma 타입만 nullable 이다 — e2e 로는 그 갈래를 만들 수
    // 없어(§6-3 「반증 불가」) 여기가 유일한 그물이다. ⛔ 널을 「무한」으로 접으면 초록이 된다.
    expect((caught as { getStatus: () => number }).getStatus()).toBe(409);
    expect((caught as { conflict: { code: string; message: string } }).conflict).toEqual({
      code: 'INVALID_STATE',
      conflictCause: 'user',
      message: '가용 재고가 모자랍니다. (가용 0)',
    });
    expect(harness.recorded.order).not.toContain('reserve');
  });

  it('⛔ 라인·헤더에 UPDATE 를 한 번도 안 쏜다 — 상태도 version_no 도 안 옮긴다', async () => {
    const harness = stub();

    await run(harness);

    // If-Match 를 받는 쓰기가 이 계약에 0건이라 올리면 화면 토큰만 낡는다(e2e P-33).
    expect(harness.recorded.sql.filter((sql) => /UPDATE\s+logistics\./.test(sql))).toEqual([]);
    expect(harness.recorded.order).not.toContain('line-update');
    expect(harness.recorded.order).not.toContain('header-update');
  });
});
