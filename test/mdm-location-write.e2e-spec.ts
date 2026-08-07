import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { deleteWarehouseContents } from './support/inventory.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-LCW';
const READER = 'E2E-LCW-R';

describe('로케이션 등록·수정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let plantId: bigint;
  let businessUnitId: bigint;
  let warehouseId: bigint;
  let otherWarehouseId: bigint;
  let inactiveWarehouseId: bigint;
  let uomId: bigint;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, [
      'MASTER_READ',
      'MASTER_LOGISTICS_WRITE',
    ]));
    ({ token: readerToken } = await createUserWithPermissions(app, READER, ['MASTER_READ']));
    ({ plantId, businessUnitId } = await createOrganization(prisma, PREFIX));

    const warehouse = async (suffix: string, isActive = true) =>
      (
        await prisma.warehouse.create({
          data: {
            plant_id: plantId,
            business_unit_id: businessUnitId,
            warehouse_code: `${PREFIX}-${suffix}`,
            warehouse_name: 'e2e 창고',
            warehouse_type_code: 'MATERIAL',
            management_level_code: 'WAREHOUSE',
            is_active: isActive,
          },
        })
      ).warehouse_id;

    warehouseId = await warehouse('WH1');
    otherWarehouseId = await warehouse('WH2');
    inactiveWarehouseId = await warehouse('WH3', false);

    uomId = (
      await prisma.uom.upsert({
        where: { uom_code: `${PREFIX}-PLT` },
        update: {},
        create: { uom_code: `${PREFIX}-PLT`, uom_name: 'e2e 팔레트' },
      })
    ).uom_id;
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    // 자식이 부모를 가리키므로 깊은 것부터 지운다.
    await prisma.location.deleteMany({ where: { location_code: { startsWith: `${PREFIX}-L` } } });
  });

  afterAll(async () => {
    await deleteWarehouseContents(prisma, PREFIX);
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  function code(): string {
    counter += 1;

    return `${PREFIX}-L${counter}`;
  }

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      warehouseId: Number(warehouseId),
      locationCode: code(),
      locationName: 'A구역 01열',
      locationTypeCode: 'RACK',
      ...overrides,
    };
  }

  function post(body: Record<string, unknown>, options: { bearer?: string; key?: string } = {}) {
    return request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  }

  function put(
    id: bigint | number,
    body: Record<string, unknown>,
    options: { etag?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .put(`/api/mdm/locations/${id}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send(body);
  }

  /** 만들고 상세 조회로 ETag 를 받는다 — 화면이 편집 전에 하는 일 그대로다. */
  async function given(
    parentLocationId?: bigint,
    inWarehouseId = warehouseId,
  ): Promise<{ id: bigint; etag: string; code: string }> {
    const locationCode = code();
    const row = await prisma.location.create({
      data: {
        warehouse_id: inWarehouseId,
        parent_location_id: parentLocationId ?? null,
        location_code: locationCode,
        location_name: '기존 자리',
        location_type_code: 'RACK',
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${row.location_id}`)
      .set('Authorization', `Bearer ${token}`);

    return { id: row.location_id, etag: detail.headers.etag, code: locationCode };
  }

  describe('등록', () => {
    it('만들면 201 이고 계약 모양으로 내려온다', async () => {
      const body = payload();

      const response = await post(body).expect(201);

      expect(response.body).toMatchObject({
        warehouseId: Number(warehouseId),
        locationCode: body.locationCode,
        locationTypeCode: 'RACK',
        parentLocationId: null,
        isActive: true,
        allowMixedItem: true,
        allowMixedLot: true,
      });
    });

    it('없는 창고면 400 이다', async () => {
      const { body } = await post(payload({ warehouseId: 999999999 })).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'warehouseId', code: 'RANGE' });
    });

    it('중지된 창고에는 만들 수 없다 — 갈 수 없는 자리가 된다', async () => {
      const { body } = await post(payload({ warehouseId: Number(inactiveWarehouseId) })).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'warehouseId', code: 'STATE_LOCKED' });
    });

    it('같은 창고에 같은 코드면 400 UNIQUE_VIOLATION 이다', async () => {
      const first = payload();
      await post(first).expect(201);

      const { body } = await post({ ...first, locationName: '중복' }).expect(400);

      expect(body.errors[0]).toMatchObject({
        field: 'locationCode',
        code: 'UNIQUE_VIOLATION',
        uniqueScope: ['warehouseId', 'locationCode'],
      });
    });

    it('다른 창고에 같은 코드는 만들 수 있다 — uq_location 은 창고 안에서만이다', async () => {
      const first = payload();
      await post(first).expect(201);

      await post({ ...first, warehouseId: Number(otherWarehouseId) }).expect(201);
    });

    it.each([
      ['locationTypeCode', 'NOPE'],
      ['qualityZoneCode', 'NOPE'],
      ['storageConditionCode', 'NOPE'],
    ])('%s 가 코드그룹에 없으면 400 이다', async (field, value) => {
      const { body } = await post(payload({ [field]: value })).expect(400);

      expect(body.errors[0]).toMatchObject({ field, code: 'RANGE' });
    });

    it.each([
      ['수량만 보내면', { capacityQty: 500 }, 'capacityUomId'],
      ['단위만 보내면', { capacityUomId: 1 }, 'capacityQty'],
    ])('용량 %s 400 PAIR 다 — 500 이 무엇인지 알 수 없다', async (_label, overrides, field) => {
      const { body } = await post(payload(overrides)).expect(400);

      expect(body.errors[0]).toMatchObject({ field, code: 'PAIR' });
    });

    it('용량 수량과 단위를 함께 보내면 만들어진다', async () => {
      const { body } = await post(
        payload({ capacityQty: 500.5, capacityUomId: Number(uomId) }),
      ).expect(201);

      expect(body.capacityQty).toBe(500.5);
      expect(body.capacityUomId).toBe(Number(uomId));
    });

    it('다른 창고의 로케이션을 상위로 지정하면 400 이다', async () => {
      const other = await given(undefined, otherWarehouseId);

      const { body } = await post(payload({ parentLocationId: Number(other.id) })).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'parentLocationId', code: 'RANGE' });
    });

    it('같은 창고의 로케이션은 상위로 지정할 수 있다', async () => {
      const parent = await given();

      const { body } = await post(payload({ parentLocationId: Number(parent.id) })).expect(201);

      expect(body.parentLocationId).toBe(Number(parent.id));
    });

    it('MASTER_READ 만 있으면 403 이다', async () => {
      await post(payload(), { bearer: readerToken }).expect(403);
    });
  });

  describe('수정 — 계층 재배치', () => {
    it('자기 자신을 상위로 지정하면 400 이다', async () => {
      const { id, etag, code: locationCode } = await given();

      const { body } = await put(
        id,
        { locationCode, locationName: 'x', locationTypeCode: 'RACK', parentLocationId: Number(id) },
        { etag },
      ).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'parentLocationId', code: 'RANGE' });
    });

    it('자기 자식을 상위로 지정하면 400 이다 — A→B→A', async () => {
      const parent = await given();
      const child = await given(parent.id);

      const { body } = await put(
        parent.id,
        {
          locationCode: parent.code,
          locationName: 'x',
          locationTypeCode: 'RACK',
          parentLocationId: Number(child.id),
        },
        { etag: parent.etag },
      ).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'parentLocationId', code: 'RANGE' });
    });

    it('손자를 상위로 지정해도 400 이다 — A→B→C→A 도 순환이다', async () => {
      const a = await given();
      const b = await given(a.id);
      const c = await given(b.id);

      await put(
        a.id,
        {
          locationCode: a.code,
          locationName: 'x',
          locationTypeCode: 'RACK',
          parentLocationId: Number(c.id),
        },
        { etag: a.etag },
      ).expect(400);
    });

    it('형제를 상위로 지정하는 것은 순환이 아니다', async () => {
      const parent = await given();
      const one = await given(parent.id);
      const two = await given(parent.id);

      const { body } = await put(
        two.id,
        {
          locationCode: two.code,
          locationName: 'x',
          locationTypeCode: 'RACK',
          parentLocationId: Number(one.id),
        },
        { etag: two.etag },
      ).expect(200);

      expect(body.parentLocationId).toBe(Number(one.id));
    });

    it.each([['등록'], ['수정']])(
      '이미 순환이 든 계층 아래에는 %s 도 막는다 — 위로 올라가는 길이 끝나지 않는다',
      async (mode) => {
        // 마이그레이션이나 손질로 이미 A→B→A 가 들어간 상황을 만든다. DB 는 막지 않는다.
        const a = await given();
        const b = await given(a.id);
        await prisma.$executeRaw`
          UPDATE mdm.location SET parent_location_id = ${b.id} WHERE location_id = ${a.id}
        `;

        try {
          if (mode === '등록') {
            const { body } = await post(payload({ parentLocationId: Number(a.id) })).expect(400);
            expect(body.errors[0]).toMatchObject({ field: 'parentLocationId', code: 'RANGE' });
          } else {
            const target = await given();
            const { body } = await put(
              target.id,
              {
                locationCode: target.code,
                locationName: 'x',
                locationTypeCode: 'RACK',
                parentLocationId: Number(a.id),
              },
              { etag: target.etag },
            ).expect(400);
            expect(body.errors[0]).toMatchObject({ field: 'parentLocationId', code: 'RANGE' });
          }
        } finally {
          // 고리를 끊어야 afterEach 의 삭제가 통과한다.
          await prisma.$executeRaw`
            UPDATE mdm.location SET parent_location_id = NULL WHERE location_id = ${a.id}
          `;
        }
      },
    );

    it('상위를 떼어 최상위로 올릴 수 있다', async () => {
      const parent = await given();
      const child = await given(parent.id);

      const { body } = await put(
        child.id,
        { locationCode: child.code, locationName: 'x', locationTypeCode: 'RACK' },
        { etag: child.etag },
      ).expect(200);

      expect(body.parentLocationId).toBeNull();
    });
  });

  describe('수정 — 그 외', () => {
    it('맞는 If-Match 면 200 이고 ETag 가 오른다', async () => {
      const { id, etag, code: locationCode } = await given();

      const response = await put(
        id,
        { locationCode, locationName: '고친 이름', locationTypeCode: 'CELL' },
        { etag },
      ).expect(200);

      expect(response.body).toMatchObject({ locationName: '고친 이름', locationTypeCode: 'CELL' });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('틀린 If-Match 면 409 다 — ConflictResponse', async () => {
      const { id, etag, code: locationCode } = await given();

      const { body } = await put(
        id,
        { locationCode, locationName: 'x', locationTypeCode: 'RACK' },
        { etag: String(Number(etag) + 5) },
      ).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });

    it.each([['warehouseId'], ['isActive']])('%s 를 보내면 400 이다 — 이 경로로 못 바꾼다', async (
      field,
    ) => {
      const { id, etag, code: locationCode } = await given();

      await put(
        id,
        { locationCode, locationName: 'x', locationTypeCode: 'RACK', [field]: 1 },
        { etag },
      ).expect(400);
    });

    it('안 보낸 선택 필드는 지워진다 — 전체 교체다', async () => {
      const { id, etag, code: locationCode } = await given();
      await prisma.location.update({
        where: { location_id: id },
        data: { capacity_qty: 500, capacity_uom_id: uomId, quality_zone_code: 'HOLD' },
      });
      const refreshed = await request(app.getHttpServer())
        .get(`/api/mdm/locations/${id}`)
        .set('Authorization', `Bearer ${token}`);

      const { body } = await put(
        id,
        { locationCode, locationName: 'x', locationTypeCode: 'RACK' },
        { etag: refreshed.headers.etag },
      ).expect(200);

      expect(body.capacityQty).toBeNull();
      expect(body.capacityUomId).toBeNull();
      expect(body.qualityZoneCode).toBeNull();
      expect(etag).toBeDefined();
    });

    it('자기 코드를 그대로 두고 이름만 고칠 수 있다', async () => {
      const { id, etag, code: locationCode } = await given();

      await put(
        id,
        { locationCode, locationName: '이름만 변경', locationTypeCode: 'RACK' },
        { etag },
      ).expect(200);
    });

    it('If-Match 가 없으면 400 이다', async () => {
      const { id, code: locationCode } = await given();

      const { body } = await put(id, {
        locationCode,
        locationName: 'x',
        locationTypeCode: 'RACK',
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });

    it('없는 로케이션은 404 다', async () => {
      await put(999999999, { locationCode: 'X', locationName: 'x', locationTypeCode: 'RACK' }, {
        etag: '1',
      }).expect(404);
    });
  });
});
