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
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
