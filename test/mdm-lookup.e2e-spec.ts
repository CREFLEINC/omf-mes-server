import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-LKP';

/** 8종이 같은 모양이라 공통 동작은 표로 돌린다. 마스터별 차이만 따로 본다. */
const LOOKUPS = [
  { path: 'uoms', code: 'uomCode', name: 'uomName', nameTerm: '개', table: 'mdm.uom', codeColumn: 'uom_code' },
  { path: 'partners', code: 'partnerCode', name: 'partnerName', nameTerm: '거래처', table: 'mdm.partner', codeColumn: 'partner_code' },
  { path: 'legal-entities', code: 'legalEntityCode', name: 'legalEntityName', nameTerm: '법인', table: 'mdm.legal_entity', codeColumn: 'legal_entity_code' },
  { path: 'business-units', code: 'businessUnitCode', name: 'businessUnitName', nameTerm: '사업부', table: 'mdm.business_unit', codeColumn: 'business_unit_code' },
  { path: 'plants', code: 'plantCode', name: 'plantName', nameTerm: '공장', table: 'mdm.plant', codeColumn: 'plant_code' },
  { path: 'production-lines', code: 'lineCode', name: 'lineName', nameTerm: '라인', table: 'mdm.production_line', codeColumn: 'line_code' },
  { path: 'processes', code: 'processCode', name: 'processName', nameTerm: '조립', table: 'mdm.process', codeColumn: 'process_code' },
  { path: 'equipments', code: 'equipmentCode', name: 'equipmentName', nameTerm: '설비', table: 'mdm.equipment', codeColumn: 'equipment_code' },
] as const;

describe('조회 전용 8종 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let legalEntityId: bigint;
  let businessUnitId: bigint;
  let plantId: bigint;
  let processId: bigint;
  let productionLineId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_READ']));
    ({ legalEntityId, businessUnitId, plantId } = await createOrganization(prisma, PREFIX));

    // 8종 각각에 사용 중 하나 + 중지 하나. 중지분은 includeInactive 를 검증한다.
    await prisma.uom.createMany({
      data: [
        { uom_code: `${PREFIX}-EA`, uom_name: 'e2e 개' },
        { uom_code: `${PREFIX}-BOX`, uom_name: 'e2e 박스', is_active: false },
      ],
    });
    await prisma.partner.createMany({
      data: [
        { partner_code: `${PREFIX}-P1`, partner_name: 'e2e 거래처', country_code: 'VNM' },
        { partner_code: `${PREFIX}-P2`, partner_name: 'e2e 폐업', is_active: false },
      ],
    });
    processId = (
      await prisma.process.create({
        data: {
          process_code: `${PREFIX}-PR1`,
          process_name: 'e2e 조립',
          process_type_code: 'ASSEMBLY',
        },
      })
    ).process_id;
    await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PR2`,
        process_name: 'e2e 폐지공정',
        process_type_code: 'ASSEMBLY',
        is_active: false,
      },
    });
    productionLineId = (
      await prisma.production_line.create({
        data: { plant_id: plantId, line_code: `${PREFIX}-L1`, line_name: 'e2e 1라인' },
      })
    ).production_line_id;
    await prisma.production_line.create({
      data: {
        plant_id: plantId,
        line_code: `${PREFIX}-L2`,
        line_name: 'e2e 폐지라인',
        is_active: false,
      },
    });
    await prisma.equipment.create({
      data: {
        plant_id: plantId,
        equipment_code: `${PREFIX}-EQ1`,
        equipment_name: 'e2e 설비',
        equipment_type_code: 'PRESS',
        status_code: 'RUNNING',
        process_id: processId,
        production_line_id: productionLineId,
        calibration_required: true,
        last_calibration_date: new Date('2026-08-07T00:00:00.000Z'),
      },
    });
    await prisma.equipment.create({
      data: {
        plant_id: plantId,
        equipment_code: `${PREFIX}-EQ2`,
        equipment_name: 'e2e 폐기설비',
        equipment_type_code: 'PRESS',
        status_code: 'SCRAPPED',
        is_active: false,
      },
    });
    // 법인·사업부·공장의 중지분 — createOrganization 이 사용 중인 것만 만든다.
    await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE2`,
        legal_entity_name: 'e2e 폐업법인',
        country_code: 'VNM',
        timezone_code: 'Asia/Ho_Chi_Minh',
        is_active: false,
      },
    });
    await prisma.business_unit.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_code: `${PREFIX}-BU2`,
        business_unit_name: 'e2e 폐지사업부',
        is_active: false,
      },
    });
    await prisma.plant.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_id: businessUnitId,
        plant_code: `${PREFIX}-PLT2`,
        plant_name: 'e2e 폐쇄공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
        is_active: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await app.close();
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(`/api/mdm/${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  describe.each(LOOKUPS)('$path', ({ path, code, name, nameTerm, table, codeColumn }) => {
    it('계약 봉투로 내려온다', async () => {
      const { body } = await get(`${path}?q=${PREFIX}`).expect(200);

      expect(body.page).toEqual({ page: 1, size: 50, total: expect.any(Number) });
      expect(body.items.length).toBeGreaterThan(0);
      expect(typeof body.items[0][code]).toBe('string');
      expect(typeof body.items[0][name]).toBe('string');
      expect(body.items[0].isActive).toBe(true);
    });

    it('기본은 사용 중인 것만 — includeInactive 로 켠다', async () => {
      const onlyActive = await get(`${path}?q=${PREFIX}`).expect(200);
      const withInactive = await get(`${path}?q=${PREFIX}&includeInactive=true`).expect(200);

      expect(withInactive.body.page.total).toBe(onlyActive.body.page.total + 1);
      expect(withInactive.body.items.some((row: { isActive: boolean }) => !row.isActive)).toBe(true);
    });

    it('명칭으로도 검색된다 — 코드만 보면 화면에서 못 찾는다', async () => {
      // 검색어는 **명칭에만** 있는 것이어야 한다. 코드에도 있는 말을 쓰면 코드만
      // 검색하는 구현으로 바꿔도 통과한다(실제로 그랬다).
      expect(`${PREFIX}-`).not.toContain(nameTerm);

      const { body } = await get(`${path}?q=${encodeURIComponent(nameTerm)}`).expect(200);

      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((row: Record<string, string>) => row[name].includes(nameTerm))).toBe(
        true,
      );
      expect(body.items.every((row: Record<string, string>) => !row[code].includes(nameTerm))).toBe(
        true,
      );
    });

    it('DB 가 정한 차례 그대로 내려온다 — 정렬이 없으면 페이지가 흔들린다', async () => {
      // 「1페이지와 2페이지가 다르다」로는 못 잡는다. 행이 몇 개뿐이면 ORDER BY 가
      // 없어도 실행 계획이 같아 같은 순서가 나온다(실제로 지워보니 통과했다).
      // DB 에 같은 정렬을 직접 물어 대조한다.
      const expected = await prisma.$queryRawUnsafe<{ c: string }[]>(
        `SELECT ${codeColumn} AS c FROM ${table} WHERE ${codeColumn} LIKE $1 ORDER BY ${codeColumn}`,
        `${PREFIX}%`,
      );

      const { body } = await get(`${path}?q=${PREFIX}&includeInactive=true&size=200`).expect(200);

      expect(body.items.map((row: Record<string, string>) => row[code])).toEqual(
        expected.map((row) => row.c),
      );
    });

    it('size 상한을 넘기면 400 이다', async () => {
      await get(`${path}?size=1000000`).expect(400);
    });

    it('토큰이 없으면 401 이다', async () => {
      await request(app.getHttpServer()).get(`/api/mdm/${path}`).expect(401);
    });
  });

  describe('부모 필터', () => {
    it('사업부는 법인으로 거른다', async () => {
      const { body } = await get(
        `business-units?legalEntityId=${legalEntityId}&includeInactive=true`,
      ).expect(200);

      expect(body.items.length).toBeGreaterThan(0);
      expect(
        body.items.every((row: { legalEntityId: number }) => row.legalEntityId === Number(legalEntityId)),
      ).toBe(true);
    });

    it('공장은 법인·사업부로 거른다', async () => {
      const { body } = await get(
        `plants?legalEntityId=${legalEntityId}&businessUnitId=${businessUnitId}&includeInactive=true`,
      ).expect(200);

      expect(body.items.length).toBeGreaterThan(0);
      expect(
        body.items.every((row: { businessUnitId: number | null }) => row.businessUnitId === Number(businessUnitId)),
      ).toBe(true);
    });

    it('생산라인은 공장으로 거른다', async () => {
      const { body } = await get(`production-lines?plantId=${plantId}`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].plantId).toBe(Number(plantId));
    });

    it('설비는 공장·공정으로 거른다', async () => {
      const { body } = await get(`equipments?plantId=${plantId}&processId=${processId}`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].equipmentCode).toBe(`${PREFIX}-EQ1`);
    });

    it('안 맞는 부모를 주면 빈 목록이다', async () => {
      const { body } = await get('production-lines?plantId=999999999').expect(200);

      expect(body.items).toEqual([]);
      expect(body.page.total).toBe(0);
    });

    it.each([
      ['uoms', 'plantId=1'],
      ['partners', 'legalEntityId=1'],
      ['processes', 'plantId=1'],
      ['production-lines', 'processId=1'],
    ])('%s 에 없는 필터를 주면 400 이다 — 조용히 무시하면 안 된다', async (path, param) => {
      // 한 DTO 에 필터를 모아 두면 통과해버린다. 화면은 걸러진 줄 안다.
      await get(`${path}?${param}`).expect(400);
    });
  });

  describe('설비 — 값이 그대로 실린다', () => {
    it('교정일이 @db.Date 인데 하루가 밀리지 않는다', async () => {
      const { body } = await get(`equipments?q=${PREFIX}-EQ1`).expect(200);

      expect(body.items[0].lastCalibrationDate).toBe('2026-08-07');
      expect(body.items[0].calibrationDueDate).toBeNull();
    });

    it('선택 참조가 없으면 null 이다', async () => {
      const { body } = await get(`equipments?q=${PREFIX}-EQ2&includeInactive=true`).expect(200);

      expect(body.items[0].processId).toBeNull();
      expect(body.items[0].productionLineId).toBeNull();
    });
  });
});
