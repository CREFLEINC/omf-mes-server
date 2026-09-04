/**
 * 실제 PostgreSQL 에 대고 돈다. 재고 이동은 **DB 상태가 곧 동작**이고, 음수 방어·불변성은
 * 트리거가 집행한다 — 흉내로는 「맞다」를 말할 수 없다.
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { InventoryPostingModule, InventoryPostingService } from '../src/core/inventory-posting';
import { PostingEndpoint, PostingInput } from '../src/core/inventory-posting/posting.types';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'POST-E2E';

describe('재고 posting (실 DB)', () => {
  let prisma: PrismaService;
  let posting: InventoryPostingService;
  let itemId: number;
  let uomId: number;
  let plantId: number;
  let businessUnitId: bigint;
  let hereA: PostingEndpoint;
  let hereB: PostingEndpoint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
        PrismaModule,
        InventoryPostingModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    posting = moduleRef.get(InventoryPostingService);

    await cleanup();

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
        negative_stock_allowed: false,
      },
    });
    itemId = Number(item.item_id);

    businessUnitId = unit.business_unit_id;
    hereA = await makeEndpoint(unit.business_unit_id, plant.plant_id, 'A', 'NORMAL');
    hereB = await makeEndpoint(unit.business_unit_id, plant.plant_id, 'B', 'NORMAL');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function makeEndpoint(
    businessUnitId: bigint,
    plantIdValue: bigint,
    suffix: string,
    quality: string,
  ): Promise<PostingEndpoint> {
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plantIdValue,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-WH${suffix}`,
        warehouse_name: `검사창고${suffix}`,
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC${suffix}`,
        location_name: `검사위치${suffix}`,
        location_type_code: 'BIN',
      },
    });
    return {
      warehouseId: Number(warehouse.warehouse_id),
      locationId: Number(location.location_id),
      qualityStatusCode: quality,
      inventoryStatusCode: 'AVAILABLE',
    };
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    );
  }

  let sequence = 0;
  function input(overrides: Partial<PostingInput> = {}): PostingInput {
    sequence += 1;
    return {
      businessDate: '2026-09-02',
      occurredAt: new Date('2026-09-02T01:00:00Z'),
      transactionTypeCode: 'MOVE',
      transactionNo: `${PREFIX}-${sequence}`,
      statusCode: 'POSTED',
      plantId,
      sourceDocumentTypeCode: 'STOCK_TRANSFER',
      sourceDocumentId: 1,
      idempotencyKey: `${PREFIX}-key-${sequence}`,
      lines: [{ itemId, qty: 10, uomId, to: hereA, ownershipTypeCode: 'OWNED' }],
      ...overrides,
    };
  }

  async function onHand(endpoint: PostingEndpoint, quality = 'NORMAL'): Promise<number> {
    const row = await prisma.inventory_balance.findFirst({
      where: {
        item_id: itemId,
        warehouse_id: endpoint.warehouseId,
        location_id: endpoint.locationId,
        quality_status_code: quality,
      },
      select: { on_hand_qty: true },
    });
    return row ? Number(row.on_hand_qty) : 0;
  }

  const run = (value: PostingInput) => prisma.$transaction((tx) => posting.post(tx, value));

  it('원장에 헤더와 라인을 남긴다', async () => {
    const result = await run(input());

    const header = await prisma.inventory_transaction.findFirstOrThrow({
      where: { inventory_transaction_id: result.inventoryTransactionId },
      include: { inventory_transaction_line: true },
    });
    expect(header.inventory_transaction_line).toHaveLength(1);
    expect(header.inventory_transaction_line[0].line_no).toBe(1);
  });

  it('to 만 있으면 그 차원의 on_hand 가 는다 — 입고', async () => {
    const before = await onHand(hereA);

    await run(input());

    expect(await onHand(hereA)).toBe(before + 10);
  });

  it('from 만 있으면 준다 — 출고', async () => {
    await run(input());
    const before = await onHand(hereA);

    await run(input({ lines: [{ itemId, qty: 4, uomId, from: hereA, ownershipTypeCode: 'OWNED' }] }));

    expect(await onHand(hereA)).toBe(before - 4);
  });

  it('둘 다 있으면 옮긴다 — 이동', async () => {
    await run(input());
    const fromBefore = await onHand(hereA);
    const toBefore = await onHand(hereB);

    await run(
      input({ lines: [{ itemId, qty: 3, uomId, from: hereA, to: hereB, ownershipTypeCode: 'OWNED' }] }),
    );

    expect(await onHand(hereA)).toBe(fromBefore - 3);
    expect(await onHand(hereB)).toBe(toBefore + 3);
  });

  it('품질 상태만 다르면 같은 자리 안에서 옮긴다 — 판정 전이', async () => {
    await run(input());
    const normalBefore = await onHand(hereA, 'NORMAL');
    const held = { ...hereA, qualityStatusCode: 'INSPECTION_PENDING' };

    await run(input({ lines: [{ itemId, qty: 2, uomId, from: hereA, to: held, ownershipTypeCode: 'OWNED' }] }));

    expect(await onHand(hereA, 'NORMAL')).toBe(normalBefore - 2);
    expect(await onHand(hereA, 'INSPECTION_PENDING')).toBe(2);
  });

  it('⭐ 라인에 from/to_qty_after_transaction 을 남긴다 — 전기 «뒤»의 잔량이다', async () => {
    await run(input());
    const result = await run(
      input({ lines: [{ itemId, qty: 1, uomId, from: hereA, to: hereB, ownershipTypeCode: 'OWNED' }] }),
    );

    const line = await prisma.inventory_transaction_line.findFirstOrThrow({
      where: { inventory_transaction_id: result.inventoryTransactionId },
    });
    expect(Number(line.from_qty_after_transaction)).toBe(await onHand(hereA));
    expect(Number(line.to_qty_after_transaction)).toBe(await onHand(hereB));
  });

  it('⛔ 같은 (멱등키, 영업일) 재전송은 새 전표를 만들지 않는다', async () => {
    const value = input();

    const first = await run(value);
    const before = await onHand(hereA);
    const second = await run({ ...value, transactionNo: `${value.transactionNo}-again` });

    expect(second.alreadyPosted).toBe(true);
    expect(second.inventoryTransactionId).toBe(first.inventoryTransactionId);
    expect(await onHand(hereA)).toBe(before);
  });

  it('⛔ 영업일이 다르면 같은 멱등키라도 다른 전표다 — C-8 이 막으려는 자리', async () => {
    const value = input();

    const first = await run(value);
    const second = await run({
      ...value,
      businessDate: '2026-09-03',
      transactionNo: `${value.transactionNo}-d2`,
    });

    expect(second.alreadyPosted).toBe(false);
    expect(second.inventoryTransactionId).not.toBe(first.inventoryTransactionId);
  });

  it('⛔ 음수 재고 미허용 품목은 잔량이 음수가 되면 막힌다', async () => {
    await expect(
      run(input({ lines: [{ itemId, qty: 99999, uomId, from: hereB, ownershipTypeCode: 'OWNED' }] })),
    ).rejects.toThrow();
  });

  it('⛔ 원장은 삭제되지 않는다 — 정정은 역트랜잭션이다', async () => {
    const result = await run(input());

    await expect(
      prisma.$executeRaw`
        DELETE FROM inventory.inventory_transaction
         WHERE inventory_transaction_id = ${result.inventoryTransactionId}`,
    ).rejects.toThrow(/역트랜잭션/);
  });

  it('⛔ 원장은 상태 «외» 수정이 막힌다 — 상태 전이만 열려 있다', async () => {
    const result = await run(input());

    // 트리거가 to_jsonb(OLD) - 'status_code' 를 비교한다 — 상태만 바뀌면 지나간다.
    await expect(
      prisma.$executeRaw`
        UPDATE inventory.inventory_transaction SET status_code = 'CANCELLED'
         WHERE inventory_transaction_id = ${result.inventoryTransactionId}`,
    ).resolves.toBe(1);

    await expect(
      prisma.$executeRaw`
        UPDATE inventory.inventory_transaction SET source_document_id = 999
         WHERE inventory_transaction_id = ${result.inventoryTransactionId}`,
    ).rejects.toThrow(/상태 외 수정이 불가/);
  });

  it('⛔ 원장 라인은 수정·삭제가 통째로 막힌다', async () => {
    const result = await run(input());

    await expect(
      prisma.$executeRaw`
        UPDATE inventory.inventory_transaction_line SET qty = 1
         WHERE inventory_transaction_id = ${result.inventoryTransactionId}`,
    ).rejects.toThrow(/역트랜잭션/);
  });

  it('⭐ 같은 «새» 차원에 동시에 전기해도 잃지 않는다 — 두 걸음의 경합 안전', async () => {
    // ①(0 행 만들기)이 동시에 여러 번 도는 자리다. ON CONFLICT DO NOTHING 이 하나만
    // 세우고 나머지는 ②의 UPDATE 가 그 행을 잠그며 줄을 선다.
    const fresh = await makeEndpoint(businessUnitId, BigInt(plantId), 'RACE', 'NORMAL');
    const concurrency = 20;

    await Promise.all(
      Array.from({ length: concurrency }, () =>
        run(input({ lines: [{ itemId, qty: 1, uomId, to: fresh, ownershipTypeCode: 'OWNED' }] })),
      ),
    );

    expect(await onHand(fresh)).toBe(concurrency);
  });

  it('⛔ 전기가 실패하면 잔량도 원장도 남지 않는다 — 한 트랜잭션이다', async () => {
    const before = await onHand(hereA);
    const value = input({
      lines: [
        { itemId, qty: 5, uomId, to: hereA, ownershipTypeCode: 'OWNED' },
        { itemId, qty: 99999, uomId, from: hereB, ownershipTypeCode: 'OWNED' },
      ],
    });

    await expect(run(value)).rejects.toThrow();

    expect(await onHand(hereA)).toBe(before);
    expect(
      await prisma.inventory_transaction.findFirst({ where: { transaction_no: value.transactionNo } }),
    ).toBeNull();
  });
});
