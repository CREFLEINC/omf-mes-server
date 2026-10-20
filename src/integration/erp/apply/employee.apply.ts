import { RowTable, Tx } from '../inbound-cycle';
import { EMPLOYEE, RelayRow, requiredText, text } from '../relay-tables';

/**
 * ERP 사원 → `mdm.department` / `mdm.worker`. ERP 에 부서 마스터가 없어 사원 행의
 * DEPT_CODE·PDEPT 로 부서를 세운다.
 *
 * ⭐ 작업자는 화면에서 고칠 수 없는 ERP 수신본이다(`worker.service.ts`). 다국어 이름(`name_vi`)만
 * MES 가 고치므로 처음 만들 때만 채운다.
 */
export const employeeTable: RowTable = {
  source: EMPLOYEE,
  async apply(tx: Tx, row: RelayRow): Promise<void> {
    // 부서는 비어 올 수 있다(중계 표에서 NULL 허용). 그때는 부서 없는 작업자다.
    const code = text(row, 'DEPT_CODE');
    // 최상위 부서는 PDEPT 가 자기 자신으로 올 수 있다 — 자기 자신을 상위로 걸면 CHECK 에 걸린다.
    const parentCode = code === '' || text(row, 'PDEPT') === code ? '' : text(row, 'PDEPT');
    const parentId = await upsertDepartment(tx, parentCode, text(row, 'PDEPT_NAME'), null);
    const departmentId = await upsertDepartment(tx, code, text(row, 'DEPT_NAME'), parentId);
    await upsertWorker(tx, row, departmentId);
  },
};

/** 재직 상태 — 시드 `APP_USER_STATUS`. */
const EMPLOYED = 'EMPLOYED';
const RESIGNED = 'RESIGNED';

/**
 * 사원의 공장은 ERP 에 없다. 부서명이 OA 로 시작하면 OA 공장(PL13), 아니면 PL11 이다 —
 * 발주·수주와 대조해 어긋난 사원이 0명이었다(`erp-gateway/docs/mes-seed-mapping.md` §7).
 */
export function plantCodeOf(departmentName: string): string {
  return departmentName.startsWith('OA') ? 'PL13' : 'PL11';
}

/**
 * 이름은 처음 만들 때의 값으로 둔다 — 같은 부서가 사원 행마다 이름이 달리 오고(V040 은 셋),
 * ERP 에 부서 마스터가 없어 「이름 변경」이 정의돼 있지 않다.
 * 이미 MES 가 만든 같은 코드의 부서가 있으면 ERP 소유로 넘긴다(ERP 가 정본).
 */
async function upsertDepartment(
  tx: Tx,
  code: string,
  name: string,
  parentId: bigint | null,
): Promise<bigint | null> {
  if (code === '') return null;
  const parent = parentId === null ? undefined : parentId;
  const found = await tx.department.findUnique({ where: { department_code: code } });
  if (found === null) {
    const created = await tx.department.create({
      data: {
        department_code: code,
        department_name: name === '' ? code : name,
        name_ko: name === '' ? null : name,
        source_system_code: 'ERP',
        parent_department_id: parent ?? null,
      },
    });
    return created.department_id;
  }
  const parentChanged = parent !== undefined && found.parent_department_id !== parent;
  if (found.source_system_code !== 'ERP' || !found.is_active || parentChanged) {
    await tx.department.update({
      where: { department_id: found.department_id },
      data: {
        source_system_code: 'ERP',
        is_active: true,
        ...(parentChanged ? { parent_department_id: parent } : {}),
        updated_by: null,
        version_no: { increment: 1 },
      },
    });
  }
  return found.department_id;
}

async function upsertWorker(tx: Tx, row: RelayRow, departmentId: bigint | null): Promise<void> {
  const workerNo = requiredText(row, 'EMP_CODE');
  const workerName = requiredText(row, 'EMP_NAME');
  // 퇴사(EXPIRE_YN=Y)와 삭제(T_FLAG=D)는 지우지 않고 끈다 — 실적·검사 기록이 작업자를 가리킨다.
  const resigned = text(row, 'EXPIRE_YN') === 'Y' || text(row, 'T_FLAG') === 'D';
  const status = resigned ? RESIGNED : EMPLOYED;

  const worker = await tx.worker.findUnique({ where: { worker_no: workerNo } });
  if (worker === null) {
    const plant = await plantOf(tx, plantCodeOf(text(row, 'DEPT_NAME')));
    await tx.worker.create({
      data: {
        worker_no: workerNo,
        worker_name: workerName,
        name_vi: workerName,
        plant_id: plant.plant_id,
        business_unit_id: plant.business_unit_id,
        department_id: departmentId,
        status_code: status,
        is_active: !resigned,
      },
    });
    return;
  }
  if (
    worker.worker_name !== workerName ||
    worker.department_id !== departmentId ||
    worker.status_code !== status ||
    worker.is_active === resigned
  ) {
    await tx.worker.update({
      where: { worker_id: worker.worker_id },
      data: {
        worker_name: workerName,
        department_id: departmentId,
        status_code: status,
        is_active: !resigned,
        updated_by: null,
        version_no: { increment: 1 },
      },
    });
  }
}

/** ⛔ 같은 코드의 공장이 둘이면 어느 쪽인지 정할 수 없다 — 고르지 않고 실패로 남긴다. */
async function plantOf(
  tx: Tx,
  plantCode: string,
): Promise<{ plant_id: bigint; business_unit_id: bigint }> {
  const plants = await tx.plant.findMany({
    where: { plant_code: plantCode },
    select: { plant_id: true, business_unit_id: true },
    take: 2,
  });
  if (plants.length !== 1) {
    throw new Error(`공장 ${plantCode} 이 ${plants.length === 0 ? '없다' : '둘 이상이다'}`);
  }
  const [plant] = plants;
  if (plant.business_unit_id === null) throw new Error(`공장 ${plantCode} 에 사업부가 없다`);
  return { plant_id: plant.plant_id, business_unit_id: plant.business_unit_id };
}
