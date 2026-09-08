import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import {
  PostTransferArriveInput,
  PostTransferIssueInput,
  TransferArriveLineInput,
  TransferArriveOrigin,
  TransferLineWriteInput,
  postTransferArrive,
  postTransferIssue,
} from './transfer-posting';

const LE = 1n;
const BU = 2n;
const PLANT = 3n;
const FROM_WH = 10n;
const FROM_LOC = 20n;
const TO_WH = 11n;
const TO_LOC = 21n;
const ITEM = 30n;
const LOT = 40n;
const UOM = 5n;
const TRANSFER_ID = 700n;
const NO = 'ST-20260512-0001';
const DAY = '2026-05-12';
const AT = new Date('2026-05-12T02:00:00.000Z');

type Row = Record<string, unknown>;

interface BalanceSeed extends Row {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  itemId: bigint;
  lotKey: bigint;
  quality_status_code: string;
  inventory_status_code: string;
  ownership_type_code: string;
  owner_partner_id: bigint | null;
  available_qty: Prisma.Decimal | null;
}

const balance = (over: Partial<BalanceSeed> = {}): BalanceSeed => ({
  legalEntityId: LE,
  businessUnitId: BU,
  plantId: PLANT,
  warehouseId: FROM_WH,
  locationId: FROM_LOC,
  itemId: ITEM,
  lotKey: LOT,
  quality_status_code: 'INSPECTION_PENDING',
  inventory_status_code: 'ON_HOLD',
  ownership_type_code: 'CONSIGNMENT',
  owner_partner_id: 9n,
  available_qty: new Prisma.Decimal(100),
  ...over,
});

const line = (over: Partial<TransferLineWriteInput> = {}): TransferLineWriteInput => ({
  stockTransferLineId: 900n,
  itemId: ITEM,
  lotId: LOT,
  qty: new Prisma.Decimal(10),
  uomId: UOM,
  fromLocationId: FROM_LOC,
  toLocationId: TO_LOC,
  handlingUnitId: null,
  ...over,
});

function fake(seed: { balances?: BalanceSeed[]; ledgerRows?: number } = {}) {
  let requested = 0;
  const models: Row = {
    warehouse: {
      findUniqueOrThrow: async () => ({
        business_unit_id: BU,
        plant_id: PLANT,
        plant: { legal_entity_id: LE },
      }),
    },
    inventory_transaction_line: {
      findMany: async () =>
        // `ledgerRows` 는 「원장이 이동 라인과 어긋난 상태」를 만드는 자리다(기본은 일치).
        Array.from({ length: seed.ledgerRows ?? requested }, (_, index) => ({
          inventory_transaction_line_id: BigInt(5000 + index),
        })),
    },
    $queryRaw: async () => seed.balances ?? [balance()],
  };
  const tx = models as unknown as Prisma.TransactionClient;

  const posted: PostingInput[] = [];
  const posting = {
    post: async (_tx: Prisma.TransactionClient, input: PostingInput) => {
      posted.push(input);
      requested = input.lines.length;
      return { inventoryTransactionId: 77n, businessDate: input.businessDate, alreadyPosted: false };
    },
  } as unknown as InventoryPostingService;

  return { tx, posting, posted };
}

const input = (over: Partial<PostTransferIssueInput> = {}): PostTransferIssueInput => ({
  stockTransferId: TRANSFER_ID,
  stockTransferNo: NO,
  fromWarehouseId: FROM_WH,
  toWarehouseId: TO_WH,
  lines: [line()],
  businessDate: DAY,
  occurredAt: AT,
  ...over,
});

describe('재고 이동 전기', () => {
  it('반출 끝점 — from 은 잠근 잔액 행의 4칸 그대로고 to 는 창고·위치만 갈리며 inventory_status_code 만 IN_TRANSIT 이다', async () => {
    const { tx, posting, posted } = fake({
      balances: [balance(), balance({ warehouseId: TO_WH, locationId: TO_LOC })],
    });

    const ledgerLineIds = await postTransferIssue(tx, posting, input(), 1);

    const written = posted[0].lines[0];
    expect(written.from).toEqual({
      warehouseId: Number(FROM_WH),
      locationId: Number(FROM_LOC),
      // ⭐ 서버가 «고르지» 않는다 — 잠근 잔액 행에서 되읽는다(QUALITY_STATUS 값 목록이 0건이다).
      qualityStatusCode: 'INSPECTION_PENDING',
      inventoryStatusCode: 'ON_HOLD',
    });
    expect(written.to).toEqual({
      warehouseId: Number(TO_WH),
      locationId: Number(TO_LOC),
      // 품질 상태는 그대로 옮긴다 — 갈아 끼우는 축은 재고 상태 하나뿐이다.
      qualityStatusCode: 'INSPECTION_PENDING',
      inventoryStatusCode: 'IN_TRANSIT',
    });
    // 소유 축도 계약에 없어 잔액 행에서 되읽는다.
    expect(written.ownershipTypeCode).toBe('CONSIGNMENT');
    expect(written.ownerPartnerId).toBe(9);
    // 원장 번호는 전표 번호 그대로고 멱등키는 «결정적»이다(도착은 `:ARRIVE` 를 쓴다).
    expect(posted[0].transactionNo).toBe(NO);
    expect(posted[0].idempotencyKey).toBe(`STOCK_TRANSFER:${NO}:ISSUE`);
    expect(ledgerLineIds).toEqual([5000n]);
  });

  it('handlingUnitId 는 있을 때만 원장 라인에 실린다', async () => {
    const { tx, posting, posted } = fake();
    await postTransferIssue(tx, posting, input({ lines: [line({ handlingUnitId: 55n })] }), 1);
    expect(posted[0].lines[0].handlingUnitId).toBe(55);

    const plain = fake();
    await postTransferIssue(plain.tx, plain.posting, input(), 1);
    expect(plain.posted[0].lines[0]).not.toHaveProperty('handlingUnitId');
  });

  it('⭐ 도착 끝점 — from 은 반출 원장 라인의 to_* 복제고 to 의 inventory_status_code 는 반출 라인의 from_inventory_status_code 다', async () => {
    // ⚠ 도착 위치에 «같은 품목·LOT 의 AVAILABLE 잔액»이 이미 서 있다 — 잠금 7칸에 두 행이
    //    걸린다. 11칸으로 고르지 않으면 두 번째 이동이 언제나 400 이 된다(재수립 R-6).
    const { tx, posting, posted } = fake({
      balances: [
        balance({ warehouseId: TO_WH, locationId: TO_LOC, inventory_status_code: 'IN_TRANSIT' }),
        balance({ warehouseId: TO_WH, locationId: TO_LOC, inventory_status_code: 'AVAILABLE' }),
        balance({ warehouseId: TO_WH, locationId: ACTUAL_LOC, inventory_status_code: 'ON_HOLD' }),
      ],
    });

    const ledgerLineIds = await postTransferArrive(tx, posting, arriveInput(), 1);

    const written = posted[0].lines[0];
    expect(written.from).toEqual({
      warehouseId: Number(TO_WH),
      locationId: Number(TO_LOC),
      qualityStatusCode: 'INSPECTION_PENDING',
      inventoryStatusCode: 'IN_TRANSIT',
    });
    expect(written.to).toEqual({
      warehouseId: Number(TO_WH),
      locationId: Number(ACTUAL_LOC),
      // 품질은 손대지 않는다.
      qualityStatusCode: 'INSPECTION_PENDING',
      // ⭐ `AVAILABLE` 고정이 아니다 — 반출 라인의 출발 상태로 되돌린다(결정 — 통보 125).
      inventoryStatusCode: 'ON_HOLD',
    });
    // 둘째 원장은 번호·멱등키가 갈린다 — 같은 영업일에 두 번 전기해도 안 부딪힌다.
    expect(posted[0].transactionNo).toBe(`${NO}-A`);
    expect(posted[0].idempotencyKey).toBe(`STOCK_TRANSFER:${NO}:ARRIVE`);
    expect(ledgerLineIds).toEqual([5000n]);
  });

  it('receivedQty=0 인 라인은 원장 라인 배열에서 빠지고 되짚기 짝짓기가 그 배열 길이로 돈다', async () => {
    const { tx, posting, posted } = fake({
      balances: [balance({ warehouseId: TO_WH, locationId: TO_LOC, inventory_status_code: 'IN_TRANSIT' })],
    });

    // 호출자가 0 수량 라인을 걸러 넘기므로 배열은 하나다 — 되짚기도 그 길이로 짝짓는다.
    const ledgerLineIds = await postTransferArrive(
      tx, posting, arriveInput({ lines: [arriveLine({ lineIndex: 1 })] }), 1,
    );

    expect(posted[0].lines).toHaveLength(1);
    expect(ledgerLineIds).toEqual([5000n]);
  });

  it('⭐ 같은 차원 라인이 둘이면 하한을 «합계»로 본다 — 라인별로 보면 둘째 UPDATE 에서 트리거가 500 이다', async () => {
    // 같은 품목·LOT·같은 출발 위치 2라인. 각 5 는 운송중 8 이하지만 합계 10 은 넘는다.
    const short = fake({
      balances: [
        balance({
          warehouseId: TO_WH, locationId: TO_LOC, inventory_status_code: 'IN_TRANSIT',
          available_qty: new Prisma.Decimal(8),
        }),
      ],
    });
    const twoLines = [
      arriveLine({ lineIndex: 0, qty: new Prisma.Decimal(5) }),
      // 0 수량 라인을 걸러 넘긴 뒤라 배열 자리(1)와 본문 자리(3)가 갈린다.
      arriveLine({ lineIndex: 3, qty: new Prisma.Decimal(5) }),
    ];

    const failure = await postTransferArrive(
      short.tx, short.posting, arriveInput({ lines: twoLines }), 1,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ContractException);
    expect((failure as ContractException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // 오류 자리는 «본문» 번호다. ⚠ 지금은 차원당 1건이 아니라 라인마다 낸다(리뷰 Nit-1).
    expect((failure as ContractException).errors).toMatchObject([
      { field: 'lines[0].receivedQty', code: 'NEGATIVE_BALANCE' },
      { field: 'lines[3].receivedQty', code: 'NEGATIVE_BALANCE' },
    ]);
    // 거부는 전기 «앞»에서 끝난다.
    expect(short.posted).toHaveLength(0);

    // 합계가 딱 맞으면 지난다 — 「언제나 거부」가 아님을 함께 못박는다.
    const exact = fake({
      balances: [
        balance({
          warehouseId: TO_WH, locationId: TO_LOC, inventory_status_code: 'IN_TRANSIT',
          available_qty: new Prisma.Decimal(10),
        }),
      ],
    });
    const ledgerLineIds = await postTransferArrive(
      exact.tx, exact.posting, arriveInput({ lines: twoLines }), 1,
    );
    expect(exact.posted[0].lines).toHaveLength(2);
    expect(ledgerLineIds).toEqual([5000n, 5001n]);
  });

  it('⛔ 원장 라인 수가 이동 라인과 다르면 던진다 — 전표 라인이 «남의 원장»을 가리키느니 되돌린다', async () => {
    const { tx, posting } = fake({
      balances: [balance({ warehouseId: TO_WH, locationId: TO_LOC, inventory_status_code: 'IN_TRANSIT' })],
      ledgerRows: 1,
    });

    await expect(
      postTransferArrive(
        tx, posting,
        arriveInput({ lines: [arriveLine(), arriveLine({ lineIndex: 1 })] }),
        1,
      ),
    ).rejects.toThrow('원장 라인 수가 이동 라인과 다르다: 1 ≠ 2');
  });
});

const ACTUAL_LOC = 22n;

const origin = (over: Partial<TransferArriveOrigin> = {}): TransferArriveOrigin => ({
  warehouseId: TO_WH,
  locationId: TO_LOC,
  qualityStatusCode: 'INSPECTION_PENDING',
  inventoryStatusCode: 'IN_TRANSIT',
  restoredInventoryStatusCode: 'ON_HOLD',
  ownershipTypeCode: 'CONSIGNMENT',
  ownerPartnerId: 9n,
  handlingUnitId: null,
  ...over,
});

const arriveLine = (over: Partial<TransferArriveLineInput> = {}): TransferArriveLineInput => ({
  lineIndex: 0,
  itemId: ITEM,
  lotId: LOT,
  uomId: UOM,
  qty: new Prisma.Decimal(10),
  origin: origin(),
  toLocationId: ACTUAL_LOC,
  ...over,
});

const arriveInput = (over: Partial<PostTransferArriveInput> = {}): PostTransferArriveInput => ({
  stockTransferId: TRANSFER_ID,
  stockTransferNo: NO,
  toWarehouseId: TO_WH,
  lines: [arriveLine()],
  businessDate: DAY,
  occurredAt: AT,
  ...over,
});
