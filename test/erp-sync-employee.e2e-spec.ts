/**
 * ERP 사원 받기 → 부서·작업자 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 *
 * 사원의 공장 PL11·PL13 이 없으면 만들어 쓰고 끝나면 지운다. 운영 DB 에는 미리 있어야 한다.
 */
import * as mssql from 'mssql';

import { employeeTable } from '../src/integration/erp/apply/employee.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { EMPLOYEE } from '../src/integration/erp/relay-tables';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RELAY,
  connectSa,
  createCopy,
  describeRelay,
  dropCopy,
  flagsOf,
  insertRow,
} from './erp-relay.fixture';

const COPY = 'E2E_ERP_EMP_TIG_DOWN';
const PREFIX = 'E2EW';
const TABLE = {
  ...employeeTable,
  source: { ...EMPLOYEE, interfaceCode: 'E2E-IF-ERP-EMP-RECV', name: COPY },
};

describeRelay('ERP 사원 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;
  const createdPlants: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, EMPLOYEE.name);
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
    await ensurePlant('PL11');
    await ensurePlant('PL13');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.plant.deleteMany({ where: { plant_id: { in: createdPlants } } });
    await dropCopy(sa, COPY);
    await sa?.close();
    await relay?.close();
    await prisma?.$disconnect();
  });

  async function ensurePlant(code: string): Promise<void> {
    if ((await prisma.plant.count({ where: { plant_code: code } })) > 0) return;
    const businessUnit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: 'asc' },
    });
    const plant = await prisma.plant.create({
      data: {
        plant_code: code,
        plant_name: `e2e ${code}`,
        legal_entity_id: businessUnit.legal_entity_id,
        business_unit_id: businessUnit.business_unit_id,
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    createdPlants.push(plant.plant_id);
  }

  async function cleanup(): Promise<void> {
    await prisma.integration_message.deleteMany({
      where: { interface_code: TABLE.source.interfaceCode },
    });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    // 자식 부서부터 — 상위를 가리키는 FK 가 있다.
    await prisma.department.deleteMany({
      where: { department_code: { startsWith: PREFIX }, parent_department_id: { not: null } },
    });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
  }

  function employee(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      EMP_CODE: `${PREFIX}${code}`,
      EMP_NAME: 'Nguyễn Thị Quỳnh',
      DEPT_CODE: `${PREFIX}-D1`,
      DEPT_NAME: 'Prduction Div. / Bộ phận Sản Xuất',
      PDEPT: `${PREFIX}-D0`,
      PDEPT_NAME: 'Representative / tổng giám đốc',
      EXPIRE_YN: 'N',
      T_SEQ: 1,
      T_FLAG: 'I',
      IF_YN: 'N',
      ...extra,
    };
  }

  const flags = () => flagsOf(sa, COPY, "EMP_CODE + '#' + CAST(T_SEQ AS nvarchar(20))", 'IF_YN');

  it('부서를 세우고 작업자를 만든다 — OA 부서 사원은 PL13 공장이다', async () => {
    await insertRow(sa, COPY, employee('001'));
    await insertRow(
      sa,
      COPY,
      employee('002', { DEPT_CODE: `${PREFIX}-D2`, DEPT_NAME: 'OA Production / Sản xuất OA' }),
    );

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    const departments = await prisma.department.findMany({
      where: { department_code: { startsWith: PREFIX } },
      include: { parent_department: true },
      orderBy: { department_code: 'asc' },
    });
    expect(
      departments.map((d) => [
        d.department_code,
        d.source_system_code,
        d.parent_department?.department_code,
      ]),
    ).toEqual([
      [`${PREFIX}-D0`, 'ERP', undefined],
      [`${PREFIX}-D1`, 'ERP', `${PREFIX}-D0`],
      [`${PREFIX}-D2`, 'ERP', `${PREFIX}-D0`],
    ]);
    const workers = await prisma.worker.findMany({
      where: { worker_no: { startsWith: PREFIX } },
      include: { plant: true, department: true },
      orderBy: { worker_no: 'asc' },
    });
    expect(
      workers.map((w) => [
        w.worker_no,
        w.plant.plant_code,
        w.department?.department_code,
        w.status_code,
      ]),
    ).toEqual([
      [`${PREFIX}001`, 'PL11', `${PREFIX}-D1`, 'EMPLOYED'],
      [`${PREFIX}002`, 'PL13', `${PREFIX}-D2`, 'EMPLOYED'],
    ]);
    expect(await flags()).toEqual({ [`${PREFIX}001#1`]: 'Y', [`${PREFIX}002#1`]: 'Y' });
  });

  it('뒤 판의 퇴사는 RESIGNED 로 끄고, 이름은 고치되 MES 가 고친 name_vi 는 남긴다', async () => {
    await prisma.worker.update({
      where: { worker_no: `${PREFIX}001` },
      data: { name_vi: 'Quỳnh (MES)' },
    });
    await insertRow(
      sa,
      COPY,
      employee('001', { T_SEQ: 2, EMP_NAME: 'Nguyễn Quỳnh', EXPIRE_YN: 'Y' }),
    );

    await cycle.run(TABLE);

    const worker = await prisma.worker.findUniqueOrThrow({ where: { worker_no: `${PREFIX}001` } });
    expect(worker).toMatchObject({
      worker_name: 'Nguyễn Quỳnh',
      name_vi: 'Quỳnh (MES)',
      status_code: 'RESIGNED',
      is_active: false,
    });
    expect((await flags())[`${PREFIX}001#2`]).toBe('Y');
  });
});
