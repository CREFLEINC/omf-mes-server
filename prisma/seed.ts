import { randomBytes, scrypt } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 기준정보 공통코드 시드.
 *
 * baseline 마이그레이션(정본 물리 모델)이 이미 OPERATION_POLICY·INVENTORY_STATUS를
 * 넣어 두므로, 여기서는 업무 도메인 코드만 추가한다.
 * 코드 체계 근거: research/2026-07-03-개념데이터모델-v2-요구사항통합.md §1
 */
const SEED = [
  {
    groupCode: 'ITEM_TYPE',
    groupName: '품목구분',
    values: [
      { code: 'RAW', codeName: '자재', order: 10 },
      { code: 'SEMI', codeName: '반제품', order: 20 },
      { code: 'FG', codeName: '제품', order: 30 },
      { code: 'MDSE', codeName: '상품', order: 40 },
      { code: 'DEV', codeName: '개발품(시제품)', order: 50 },
    ],
  },
  {
    groupCode: 'INSPECTION_TYPE',
    groupName: '검사유형',
    values: [
      { code: 'IQC', codeName: '수입검사', order: 10 },
      { code: 'PQC', codeName: '공정검사', order: 20 },
      { code: 'OQC', codeName: '출하검사', order: 30 },
    ],
  },
  {
    // DDL 주석이 값을 명시한다: line_type_code = LINE | WORK_AREA
    groupCode: 'LINE_TYPE',
    groupName: '라인 유형',
    values: [
      { code: 'LINE', codeName: '라인', order: 10 },
      { code: 'WORK_AREA', codeName: '작업구역', order: 20 },
    ],
  },
  {
    // 기술스택 결정 16의 폼팩터 3종: 관리 웹 / POP 패널 PC / 모바일 스캐너
    groupCode: 'TERMINAL_TYPE',
    groupName: '단말 유형',
    values: [
      { code: 'ADMIN_WEB', codeName: '관리 웹', order: 10 },
      { code: 'POP', codeName: 'POP 단말', order: 20 },
      { code: 'MOBILE', codeName: '모바일 스캐너', order: 30 },
    ],
  },
  {
    groupCode: 'TERMINAL_STATUS',
    groupName: '단말 상태',
    values: [
      { code: 'NORMAL', codeName: '정상', order: 10 },
      { code: 'MAINTENANCE', codeName: '점검중', order: 20 },
      { code: 'DISPOSED', codeName: '폐기', order: 30 },
    ],
  },
  {
    groupCode: 'USER_STATUS',
    groupName: '계정 상태',
    values: [
      { code: 'ACTIVE', codeName: '사용', order: 10 },
      { code: 'SUSPENDED', codeName: '정지', order: 20 },
      { code: 'DISABLED', codeName: '해지', order: 30 },
    ],
  },
  {
    /**
     * 기능 권한 — REQ-PR-0015(사용자별 접근 기능 분리)의 **임시 체계**.
     *
     * 요구사항 명세서 §미결 9 「사용자 유형/권한/접근 범위 정의」가 고객 액션 대기라,
     * 확정 전까지 쓸 최소 골격이다. 워크플로우 문서의 실제 담당 주체(전산담당·생산관리자·
     * 품질담당·설비담당·물류담당)를 그대로 축으로 삼았다.
     *
     * **조회는 하나로 둔다.** 기준정보를 못 보게 막을 실익이 거의 없고, 나누면 담당자가
     * 남의 도메인 코드를 참조할 때마다 막힌다. 쓰기·비활성화만 도메인별로 나눈다.
     */
    groupCode: 'PERMISSION',
    groupName: '기능 권한',
    values: [
      { code: 'MASTER_READ', codeName: '기준정보 조회(전체)', order: 10 },

      { code: 'MASTER_PRODUCTION_WRITE', codeName: '생산 기준정보 등록·수정', order: 20 },
      { code: 'MASTER_PRODUCTION_DEACTIVATE', codeName: '생산 기준정보 비활성화', order: 21 },

      { code: 'MASTER_QUALITY_WRITE', codeName: '품질 기준정보 등록·수정', order: 30 },
      { code: 'MASTER_QUALITY_DEACTIVATE', codeName: '품질 기준정보 비활성화', order: 31 },

      { code: 'MASTER_EQUIPMENT_WRITE', codeName: '설비·금형 등록·수정', order: 40 },
      { code: 'MASTER_EQUIPMENT_DEACTIVATE', codeName: '설비·금형 비활성화', order: 41 },

      { code: 'MASTER_LOGISTICS_WRITE', codeName: '물류 기준정보 등록·수정', order: 50 },
      { code: 'MASTER_LOGISTICS_DEACTIVATE', codeName: '물류 기준정보 비활성화', order: 51 },

      { code: 'MASTER_ORGANIZATION_WRITE', codeName: '조직·인원 기준정보 등록·수정', order: 60 },
      { code: 'MASTER_ORGANIZATION_DEACTIVATE', codeName: '조직·인원 기준정보 비활성화', order: 61 },

      { code: 'MASTER_SYSTEM_WRITE', codeName: '시스템 설정 등록·수정', order: 70 },
      { code: 'MASTER_SYSTEM_DEACTIVATE', codeName: '시스템 설정 비활성화', order: 71 },

      { code: 'ACCESS_READ', codeName: '접근권한 조회', order: 80 },
      { code: 'ACCESS_WRITE', codeName: '접근권한 관리(단말 토큰 발급 포함)', order: 81 },
    ],
  },
  {
    groupCode: 'WORKER_STATUS',
    groupName: '재직 상태',
    values: [
      { code: 'ACTIVE', codeName: '재직', order: 10 },
      { code: 'LEAVE', codeName: '휴직', order: 20 },
      { code: 'RESIGNED', codeName: '퇴직', order: 30 },
    ],
  },
  {
    // DDL 주석이 용도를 명시한다: 공정 수행 자격(FR-WO-009/022) · 검사자 자격(FR-QM-014)
    groupCode: 'QUALIFICATION_TYPE',
    groupName: '자격 유형',
    values: [
      { code: 'PROCESS_OPERATION', codeName: '공정 수행', order: 10 },
      { code: 'INSPECTOR', codeName: '검사자', order: 20 },
    ],
  },
  {
    // 개념모델 v2 §1 툴/금형의 '신규입고/폐기 상태'를 축으로 삼았다.
    groupCode: 'MOLD_STATUS',
    groupName: '금형 상태',
    values: [
      { code: 'NEW', codeName: '신규입고', order: 10 },
      { code: 'NORMAL', codeName: '정상', order: 20 },
      { code: 'REPAIR', codeName: '수리중', order: 30 },
      { code: 'DISPOSED', codeName: '폐기', order: 40 },
    ],
  },
  {
    groupCode: 'EQUIPMENT_TYPE',
    groupName: '설비 유형',
    values: [
      { code: 'MACHINE', codeName: '생산설비', order: 10 },
      { code: 'INSPECTION', codeName: '검사장비', order: 20 },
      { code: 'UTILITY', codeName: '유틸리티설비', order: 30 },
    ],
  },
  {
    // 개념모델 v2 §1 설비의 '신규입고/폐기 상태'를 축으로 삼았다.
    groupCode: 'EQUIPMENT_STATUS',
    groupName: '설비 상태',
    values: [
      { code: 'NEW', codeName: '신규입고', order: 10 },
      { code: 'NORMAL', codeName: '정상', order: 20 },
      { code: 'MAINTENANCE', codeName: '점검중', order: 30 },
      { code: 'BREAKDOWN', codeName: '고장', order: 40 },
      { code: 'DISPOSED', codeName: '폐기', order: 50 },
    ],
  },
  {
    // 확정된 축은 '외주공정 구분'(개념모델 v2 §1 공정) 하나뿐이라 그 축만 넣는다.
    // 사출/조립/검사 같은 공정 분류축이 필요하면 값을 추가하거나 별도 코드그룹으로 뺀다.
    groupCode: 'PROCESS_TYPE',
    groupName: '공정 유형',
    values: [
      { code: 'INTERNAL', codeName: '자체공정', order: 10 },
      { code: 'OUTSOURCED', codeName: '외주공정', order: 20 },
    ],
  },
  {
    groupCode: 'PARTNER_ROLE_TYPE',
    groupName: '거래처 역할',
    values: [
      { code: 'SUPPLIER', codeName: '공급사', order: 10 },
      { code: 'CUSTOMER', codeName: '고객', order: 20 },
      { code: 'SUBCONTRACTOR', codeName: '외주처', order: 30 },
      { code: 'CARRIER', codeName: '운송업체', order: 40 },
    ],
  },
  {
    groupCode: 'LOT_CONTROL_TYPE',
    groupName: 'LOT 관리방식',
    values: [
      { code: 'NONE', codeName: 'LOT 미관리', order: 10 },
      { code: 'LOT', codeName: 'LOT 관리', order: 20 },
    ],
  },
  {
    groupCode: 'SERIAL_CONTROL_TYPE',
    groupName: '일련번호 관리방식',
    values: [
      { code: 'NONE', codeName: '미관리', order: 10 },
      { code: 'SERIAL', codeName: '개별 일련번호 관리', order: 20 },
    ],
  },
  {
    groupCode: 'FIFO_POLICY',
    groupName: '선출 정책',
    values: [
      { code: 'FIFO', codeName: '선입선출', order: 10 },
      { code: 'FEFO', codeName: '유효기간 임박 우선', order: 20 },
    ],
  },
  {
    groupCode: 'MANAGEMENT_LEVEL',
    groupName: '창고 관리수준',
    values: [
      { code: 'WAREHOUSE', codeName: '창고', order: 10 },
      { code: 'ZONE', codeName: '구역', order: 20 },
      { code: 'RACK', codeName: '랙', order: 30 },
      { code: 'CELL', codeName: '셀', order: 40 },
    ],
  },
  {
    groupCode: 'LOCATION_TYPE',
    groupName: '로케이션 유형',
    values: [
      { code: 'ZONE', codeName: '구역', order: 10 },
      { code: 'RACK', codeName: '랙', order: 20 },
      { code: 'CELL', codeName: '셀', order: 30 },
      { code: 'DOCK', codeName: '입하장', order: 40 },
    ],
  },
  {
    groupCode: 'QUALITY_ZONE',
    groupName: '품질구역',
    values: [
      { code: 'AVAILABLE', codeName: '가용', order: 10 },
      { code: 'INSPECTION', codeName: '검사대기', order: 20 },
      { code: 'HOLD', codeName: '보류', order: 30 },
      { code: 'QUARANTINE', codeName: '격리', order: 40 },
    ],
  },
  {
    groupCode: 'STORAGE_CONDITION',
    groupName: '보관조건',
    values: [
      { code: 'NORMAL', codeName: '상온', order: 10 },
      { code: 'COLD', codeName: '냉장', order: 20 },
      { code: 'FROZEN', codeName: '냉동', order: 30 },
      { code: 'HAZARD', codeName: '위험물', order: 40 },
    ],
  },
  {
    groupCode: 'WAREHOUSE_TYPE',
    groupName: '창고유형',
    values: [
      { code: 'MATERIAL', codeName: '자재창고', order: 10 },
      { code: 'SEMI', codeName: '반제품창고', order: 20 },
      { code: 'PRODUCT', codeName: '제품창고', order: 30 },
      { code: 'MDSE', codeName: '상품창고', order: 40 },
      { code: 'PRODUCTION', codeName: '생산창고', order: 50 },
      { code: 'DEFECT', codeName: '불량창고', order: 60 },
      { code: 'REWORK', codeName: '재작업공간', order: 70 },
    ],
  },
  {
    // BOM·Routing·검사기준은 개정(Rev) 단위로 살아 있다 — 상태축이 곧 개정 수명주기다.
    groupCode: 'REVISION_STATUS',
    groupName: '개정 상태',
    values: [
      { code: 'DRAFT', codeName: '작성중', order: 10 },
      { code: 'ACTIVE', codeName: '적용중', order: 20 },
      { code: 'OBSOLETE', codeName: '폐기', order: 30 },
    ],
  },
  {
    // v2에서 required_completion_rate를 뺐으므로 선후행 관계는 유형만 남는다.
    groupCode: 'DEPENDENCY_TYPE',
    groupName: '공정 선후행 유형',
    values: [
      { code: 'FINISH_TO_START', codeName: '선행 완료 후 착수', order: 10 },
      { code: 'START_TO_START', codeName: '동시 착수', order: 20 },
      { code: 'FINISH_TO_FINISH', codeName: '동시 완료', order: 30 },
    ],
  },
  {
    groupCode: 'SAMPLING_METHOD',
    groupName: '샘플링 방식',
    values: [
      { code: 'FULL', codeName: '전수검사', order: 10 },
      { code: 'FIXED', codeName: '고정 수량 샘플링', order: 20 },
      { code: 'AQL', codeName: 'AQL 샘플링', order: 30 },
    ],
  },
  {
    // PQC 초중종·자주검사는 '주기' 축이다 — 검사유형(INSPECTION_TYPE)과 섞지 않는다.
    groupCode: 'INSPECTION_FREQUENCY',
    groupName: '검사 주기',
    values: [
      { code: 'EVERY_LOT', codeName: 'LOT 단위', order: 10 },
      { code: 'FIRST_MIDDLE_LAST', codeName: '초·중·종물', order: 20 },
      { code: 'SELF', codeName: '자주검사', order: 30 },
      { code: 'PERIODIC', codeName: '주기(시간·수량)', order: 40 },
    ],
  },
  {
    // inspection_plan_version.frequency_interval_value의 단위 — 주기가 PERIODIC일 때만 쓴다.
    groupCode: 'FREQUENCY_INTERVAL_UOM',
    groupName: '검사주기 단위',
    values: [
      { code: 'HOUR', codeName: '시간', order: 10 },
      { code: 'MINUTE', codeName: '분', order: 20 },
      { code: 'QTY', codeName: '수량', order: 30 },
      { code: 'SHIFT', codeName: '교대', order: 40 },
    ],
  },
  {
    groupCode: 'INSPECTION_DATA_TYPE',
    groupName: '검사항목 데이터유형',
    values: [
      { code: 'NUMERIC', codeName: '계량형(수치)', order: 10 },
      { code: 'BOOLEAN', codeName: '계수형(합·부)', order: 20 },
      { code: 'TEXT', codeName: '서술형', order: 30 },
    ],
  },
  {
    groupCode: 'INSPECTION_METHOD',
    groupName: '검사 방법',
    values: [
      { code: 'VISUAL', codeName: '육안검사', order: 10 },
      { code: 'MEASURE', codeName: '계측', order: 20 },
      { code: 'GAUGE', codeName: '게이지', order: 30 },
      { code: 'FUNCTION', codeName: '기능검사', order: 40 },
    ],
  },
  {
    // numbering_rule.document_type_code — 채번 대상 문서. 물리 모델의 *_no 컬럼 보유
    // 트랜잭션과 LOT이 대상이다(예: 'WO-{PLANT}-{YYMMDD}-{SEQ4}').
    groupCode: 'DOCUMENT_TYPE',
    groupName: '채번 문서유형',
    values: [
      { code: 'LOT', codeName: 'LOT 번호', order: 10 },
      { code: 'WORK_ORDER', codeName: '작업지시', order: 20 },
      { code: 'PRODUCTION_RESULT', codeName: '생산실적', order: 30 },
      { code: 'INSPECTION_REQUEST', codeName: '검사요청', order: 40 },
      { code: 'INSPECTION_RESULT', codeName: '검사결과', order: 50 },
      { code: 'GOODS_RECEIPT', codeName: '입고', order: 60 },
      { code: 'GOODS_ISSUE', codeName: '출고', order: 70 },
      { code: 'SHIPMENT', codeName: '출하', order: 80 },
      { code: 'STOCK_TRANSFER', codeName: '재고이동', order: 90 },
      { code: 'NONCONFORMANCE', codeName: '부적합', order: 100 },
    ],
  },
  {
    // 채번 시퀀스를 언제 1로 되돌리나. numbering_counter.period_key의 산출 단위가 된다.
    groupCode: 'RESET_CYCLE',
    groupName: '채번 리셋주기',
    values: [
      { code: 'NONE', codeName: '리셋 없음(연속)', order: 10 },
      { code: 'DAILY', codeName: '일 단위', order: 20 },
      { code: 'MONTHLY', codeName: '월 단위', order: 30 },
      { code: 'YEARLY', codeName: '연 단위', order: 40 },
    ],
  },
  {
    groupCode: 'APPROVAL_TYPE',
    groupName: '결재 유형',
    values: [
      { code: 'CONCESSION', codeName: '특채(수리 없이 사용)', order: 10 },
      { code: 'DISPOSITION', codeName: '부적합 처리 판정', order: 20 },
      { code: 'MATERIAL_SUBSTITUTION', codeName: '대체자재 사용', order: 30 },
      { code: 'INVENTORY_ADJUSTMENT', codeName: '재고 조정', order: 40 },
      { code: 'LATE_ENTRY', codeName: '마감 후 정정', order: 50 },
    ],
  },
  {
    // approval_route_step.approver_type_code — DDL 주석이 값을 명시한다: USER | ROLE | DEPARTMENT
    groupCode: 'APPROVER_TYPE',
    groupName: '승인자 지정 방식',
    values: [
      { code: 'USER', codeName: '지정 사용자', order: 10 },
      { code: 'ROLE', codeName: '역할', order: 20 },
      { code: 'DEPARTMENT', codeName: '부서', order: 30 },
    ],
  },
  {
    // OPERATION_POLICY 14종은 baseline 마이그레이션이 시드한다. 여기서는 그 뒤에 생긴
    // 정책코드만 더한다(값 upsert라 기존 14종은 건드리지 않는다).
    //
    // 자격 검증을 처음부터 강제하면 worker_qualification이 비어 있어 전원이 무자격이 되고
    // 현장이 선다. 점검 통제(QA #9)와 같은 3단계 설정형으로 두고 기본은 끈다.
    groupCode: 'OPERATION_POLICY',
    groupName: '운영정책 코드',
    values: [
      {
        code: 'WORKER_QUALIFICATION_ENFORCEMENT',
        codeName: '작업자 자격 검증 수준(BLOCK|WARN|OFF)',
        order: 150,
      },
    ],
  },
  {
    groupCode: 'CALIBRATION_RESULT',
    groupName: '검교정 결과',
    values: [
      { code: 'PASS', codeName: '적합', order: 10 },
      { code: 'ADJUSTED', codeName: '조정 후 적합', order: 20 },
      { code: 'FAIL', codeName: '부적합', order: 30 },
    ],
  },
];

/**
 * 역할 프리셋 — REQ-PR-0015 확정 전까지 쓸 임시 골격.
 * 워크플로우 문서의 실제 담당 주체를 그대로 옮겼다. 고객이 부서·권한 범위를 확정하면
 * 이 표를 갈아끼운다.
 */
const ROLES = [
  {
    code: 'SYSTEM_ADMIN',
    name: '시스템 관리자(전산담당)',
    permissions: [
      'MASTER_READ',
      'MASTER_PRODUCTION_WRITE',
      'MASTER_PRODUCTION_DEACTIVATE',
      'MASTER_QUALITY_WRITE',
      'MASTER_QUALITY_DEACTIVATE',
      'MASTER_EQUIPMENT_WRITE',
      'MASTER_EQUIPMENT_DEACTIVATE',
      'MASTER_LOGISTICS_WRITE',
      'MASTER_LOGISTICS_DEACTIVATE',
      'MASTER_ORGANIZATION_WRITE',
      'MASTER_ORGANIZATION_DEACTIVATE',
      'MASTER_SYSTEM_WRITE',
      'MASTER_SYSTEM_DEACTIVATE',
      'ACCESS_READ',
      'ACCESS_WRITE',
    ],
  },
  {
    code: 'PRODUCTION_MANAGER',
    name: '생산관리자',
    permissions: ['MASTER_READ', 'MASTER_PRODUCTION_WRITE', 'MASTER_PRODUCTION_DEACTIVATE'],
  },
  {
    code: 'QUALITY_MANAGER',
    name: '품질담당',
    permissions: ['MASTER_READ', 'MASTER_QUALITY_WRITE', 'MASTER_QUALITY_DEACTIVATE'],
  },
  {
    code: 'EQUIPMENT_MANAGER',
    name: '설비담당',
    permissions: ['MASTER_READ', 'MASTER_EQUIPMENT_WRITE', 'MASTER_EQUIPMENT_DEACTIVATE'],
  },
  {
    code: 'LOGISTICS_MANAGER',
    name: '물류담당',
    permissions: ['MASTER_READ', 'MASTER_LOGISTICS_WRITE', 'MASTER_LOGISTICS_DEACTIVATE'],
  },
  { code: 'VIEWER', name: '조회 전용', permissions: ['MASTER_READ'] },
];

/**
 * 기본 단위(UoM). 품목·로케이션 수용량이 참조한다.
 * decimal_scale = 수량 소수 자릿수(DB 제약 0~6).
 */
const UOMS = [
  { code: 'EA', name: '개', scale: 0 },
  { code: 'KG', name: '킬로그램', scale: 3 },
  { code: 'G', name: '그램', scale: 3 },
  { code: 'M', name: '미터', scale: 3 },
  { code: 'BOX', name: '박스', scale: 0 },
  { code: 'PLT', name: '파렛트', scale: 0 },
];

async function main(): Promise<void> {
  for (const uom of UOMS) {
    await prisma.uom.upsert({
      where: { uom_code: uom.code },
      update: { uom_name: uom.name, decimal_scale: uom.scale, is_active: true },
      create: { uom_code: uom.code, uom_name: uom.name, decimal_scale: uom.scale },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`seeded UOM (${UOMS.length})`);

  for (const group of SEED) {
    const saved = await prisma.code_group.upsert({
      where: { group_code: group.groupCode },
      update: { group_name: group.groupName, is_active: true },
      create: { group_code: group.groupCode, group_name: group.groupName },
    });

    for (const value of group.values) {
      await prisma.code_value.upsert({
        where: {
          code_group_id_code: { code_group_id: saved.code_group_id, code: value.code },
        },
        update: { code_name: value.codeName, display_order: value.order, is_active: true },
        create: {
          code_group_id: saved.code_group_id,
          code: value.code,
          code_name: value.codeName,
          display_order: value.order,
        },
      });
    }

    // eslint-disable-next-line no-console
    console.log(`seeded ${group.groupCode} (${group.values.length} values)`);
  }

  await seedRoles();
  await seedAdmin();
}

/**
 * 최초 관리자 부트스트랩.
 *
 * 비밀번호는 ADMIN_INITIAL_PASSWORD로 주고, 없으면 무작위 생성해 **1회만** 출력한다.
 * 하드코딩된 기본 비밀번호를 두지 않기 위해서다 — 그런 값은 운영까지 그대로 살아남는다.
 * 어느 경우든 must_change_password=true라 첫 로그인에서 변경해야 한다.
 *
 * 해시 형식은 src/auth/password.service.ts와 같아야 한다(scrypt$N$r$p$salt$hash).
 */
/**
 * 역할·권한 매핑. **admin 존재 여부와 무관하게 매번 돌아야 한다** —
 * 권한 코드가 바뀌었는데 seedAdmin의 early-return에 묶여 있으면 기존 설치가 갱신되지 않는다.
 *
 * 목록에 없는 권한은 지운다. 그러지 않으면 권한을 회수해도 예전 부여가 남는다.
 */
async function seedRoles(): Promise<void> {
  for (const role of ROLES) {
    const saved = await prisma.role.upsert({
      where: { role_code: role.code },
      update: { role_name: role.name, is_active: true },
      create: { role_code: role.code, role_name: role.name },
    });

    for (const code of role.permissions) {
      await prisma.role_permission.upsert({
        where: { role_id_permission_code: { role_id: saved.role_id, permission_code: code } },
        update: {},
        create: { role_id: saved.role_id, permission_code: code },
      });
    }
    await prisma.role_permission.deleteMany({
      where: { role_id: saved.role_id, permission_code: { notIn: role.permissions } },
    });

    // eslint-disable-next-line no-console
    console.log(`seeded role ${role.code} (${role.permissions.length} permissions)`);
  }
}

async function seedAdmin(): Promise<void> {
  const LOGIN_ID = 'admin';
  const existing = await prisma.app_user.findUnique({
    where: { login_id: LOGIN_ID },
    include: { user_credential: true },
  });
  if (existing?.user_credential) {
    // eslint-disable-next-line no-console
    console.log('admin 계정·자격증명이 이미 있어 건너뜀');
    return;
  }

  const password = process.env.ADMIN_INITIAL_PASSWORD ?? randomBytes(12).toString('base64url');
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 }, (e, d) =>
      e ? reject(e) : resolve(d),
    ),
  );
  const hash = ['scrypt', 2 ** 15, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');

  const admin =
    existing ??
    (await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '시스템 관리자', status_code: 'ACTIVE' },
    }));

  await prisma.user_credential.create({
    data: { app_user_id: admin.app_user_id, password_hash: hash, must_change_password: true },
  });

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { role_code: 'SYSTEM_ADMIN' } });
  await prisma.user_role.upsert({
    where: { app_user_id_role_id: { app_user_id: admin.app_user_id, role_id: adminRole.role_id } },
    update: {},
    create: { app_user_id: admin.app_user_id, role_id: adminRole.role_id },
  });

  // eslint-disable-next-line no-console
  console.log(
    process.env.ADMIN_INITIAL_PASSWORD
      ? 'seeded admin (비밀번호=ADMIN_INITIAL_PASSWORD, 첫 로그인에서 변경 필요)'
      : `seeded admin — 초기 비밀번호: ${password}  ← 지금 기록하십시오. 다시 표시되지 않습니다.`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
