import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { employeeTable, plantCodeOf } from './employee.apply';

type Row = Record<string, unknown>;

/** 부서·작업자·공장. 쓰기는 `writes` 에 남기고 표에도 반영해 다음 조회가 본다. */
function fake(seed: { departments?: Row[]; workers?: Row[]; plants?: Row[] } = {}) {
  const writes: { op: string; data: Row }[] = [];
  const departments = new Map((seed.departments ?? []).map((d) => [d.department_code, d]));
  const workers = new Map((seed.workers ?? []).map((w) => [w.worker_no, w]));
  const plants = seed.plants ?? [
    { plant_id: 11n, plant_code: 'PL11', business_unit_id: 1n },
    { plant_id: 13n, plant_code: 'PL13', business_unit_id: 3n },
  ];
  let nextId = 100n;
  const tx = {
    department: {
      findUnique: async (a: { where: { department_code: string } }) =>
        departments.get(a.where.department_code) ?? null,
      create: async (a: { data: Row }) => {
        writes.push({ op: 'department.create', data: a.data });
        const row = { department_id: (nextId += 1n), is_active: true, ...a.data };
        departments.set(a.data.department_code, row);
        return row;
      },
      update: async (a: { where: Row; data: Row }) => {
        writes.push({ op: 'department.update', data: a.data });
      },
    },
    worker: {
      findUnique: async (a: { where: { worker_no: string } }) =>
        workers.get(a.where.worker_no) ?? null,
      create: async (a: { data: Row }) => writes.push({ op: 'worker.create', data: a.data }),
      update: async (a: { where: Row; data: Row }) =>
        writes.push({ op: 'worker.update', data: a.data }),
    },
    plant: {
      findMany: async (a: { where: { plant_code: string } }) =>
        plants.filter((p) => p.plant_code === a.where.plant_code),
    },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: 1,
    EMP_CODE: '900028',
    EMP_NAME: 'Trương Mạnh Cường',
    DEPT_CODE: 'V030',
    DEPT_NAME: 'Prduction Div. / Bộ phận Sản Xuất',
    PDEPT: 'V000',
    PDEPT_NAME: 'Representative / tổng giám đốc',
    EXPIRE_YN: 'N',
    T_FLAG: 'I',
    T_SEQ: '1',
    ...extra,
  };
}

const PARENT = {
  department_id: 1n,
  department_code: 'V000',
  parent_department_id: null,
  source_system_code: 'ERP',
  is_active: true,
};
const DEPT = { ...PARENT, department_id: 2n, department_code: 'V030', parent_department_id: 1n };
const WORKER = {
  worker_id: 5n,
  worker_no: '900028',
  worker_name: 'Trương Mạnh Cường',
  department_id: 2n,
  status_code: 'EMPLOYED',
  is_active: true,
};

describe('employeeTable', () => {
  it('처음 받으면 상위 부서·부서·작업자를 만든다', async () => {
    const f = fake();

    await employeeTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'department.create',
        data: expect.objectContaining({ department_code: 'V000', source_system_code: 'ERP' }),
      },
      {
        op: 'department.create',
        data: expect.objectContaining({ department_code: 'V030', parent_department_id: 101n }),
      },
      {
        op: 'worker.create',
        data: {
          worker_no: '900028',
          worker_name: 'Trương Mạnh Cường',
          name_vi: 'Trương Mạnh Cường',
          plant_id: 11n,
          business_unit_id: 1n,
          department_id: 102n,
          status_code: 'EMPLOYED',
          is_active: true,
        },
      },
    ]);
  });

  it('부서명이 OA 로 시작하면 PL13, 아니면 PL11 이다', () => {
    expect(plantCodeOf('OA Production / Sản xuất OA')).toBe('PL13');
    expect(plantCodeOf('QC Div. / Chất lượng')).toBe('PL11');
  });

  it('같은 값이면 아무것도 바꾸지 않는다', async () => {
    const f = fake({ departments: [PARENT, DEPT], workers: [WORKER] });

    await employeeTable.apply(f.tx, erp());

    expect(f.writes).toEqual([]);
  });

  it('부서 이름은 처음 값으로 두고 다른 이름이 와도 바꾸지 않는다', async () => {
    const f = fake({ departments: [PARENT, DEPT], workers: [WORKER] });

    await employeeTable.apply(f.tx, erp({ DEPT_NAME: 'QC Div.  / Ch?t l??ng' }));

    expect(f.writes).toEqual([]);
  });

  it('MES 가 만든 같은 코드의 부서는 ERP 소유로 넘긴다', async () => {
    const f = fake({
      departments: [PARENT, { ...DEPT, source_system_code: 'MES' }],
      workers: [WORKER],
    });

    await employeeTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'department.update',
        data: expect.objectContaining({ source_system_code: 'ERP', version_no: { increment: 1 } }),
      },
    ]);
  });

  it('상위 부서가 바뀌면 다시 잇는다', async () => {
    const other = { ...PARENT, department_id: 9n, department_code: 'V010' };
    const f = fake({ departments: [PARENT, other, DEPT], workers: [WORKER] });

    await employeeTable.apply(f.tx, erp({ PDEPT: 'V010' }));

    expect(f.writes).toEqual([
      {
        op: 'department.update',
        data: expect.objectContaining({ parent_department_id: 9n }),
      },
    ]);
  });

  it('상위 부서가 자기 자신으로 오면 잇지 않는다', async () => {
    const f = fake({ departments: [PARENT], workers: [] });

    await employeeTable.apply(f.tx, erp({ DEPT_CODE: 'V000', PDEPT: 'V000' }));

    expect(f.writes.map((w) => w.op)).toEqual(['worker.create']);
  });

  it('부서가 비어 오면 부서 없는 작업자로 PL11 에 둔다', async () => {
    const f = fake();

    await employeeTable.apply(f.tx, erp({ DEPT_CODE: null, DEPT_NAME: null }));

    expect(f.writes).toEqual([
      {
        op: 'worker.create',
        data: expect.objectContaining({ department_id: null, plant_id: 11n }),
      },
    ]);
  });

  it.each([
    ['퇴사(EXPIRE_YN=Y)', { EXPIRE_YN: 'Y' }],
    ['삭제(T_FLAG=D)', { T_FLAG: 'D' }],
  ])('%s 면 지우지 않고 RESIGNED 로 끈다', async (_, extra) => {
    const f = fake({ departments: [PARENT, DEPT], workers: [WORKER] });

    await employeeTable.apply(f.tx, erp(extra));

    expect(f.writes).toEqual([
      {
        op: 'worker.update',
        data: expect.objectContaining({ status_code: 'RESIGNED', is_active: false }),
      },
    ]);
  });

  it('이름이 바뀌면 고치되 MES 가 고치는 name_vi 와 공장은 건드리지 않는다', async () => {
    const f = fake({ departments: [PARENT, DEPT], workers: [WORKER] });

    await employeeTable.apply(f.tx, erp({ EMP_NAME: 'Trương Cường' }));

    expect(f.writes).toEqual([
      {
        op: 'worker.update',
        data: {
          worker_name: 'Trương Cường',
          department_id: 2n,
          status_code: 'EMPLOYED',
          is_active: true,
          updated_by: null,
          version_no: { increment: 1 },
        },
      },
    ]);
  });

  it.each([
    ['없으면', []],
    [
      '둘이면',
      [
        { plant_id: 1n, plant_code: 'PL11', business_unit_id: 1n },
        { plant_id: 2n, plant_code: 'PL11', business_unit_id: 1n },
      ],
    ],
    ['사업부가 없으면', [{ plant_id: 1n, plant_code: 'PL11', business_unit_id: null }]],
  ])('새 작업자의 공장이 %s 실패한다', async (_, plants) => {
    const f = fake({ departments: [PARENT, DEPT], plants });

    await expect(employeeTable.apply(f.tx, erp())).rejects.toThrow('공장 PL11');
  });
});
