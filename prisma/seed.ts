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

async function main(): Promise<void> {
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
