import { DataSource, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 초기 공통코드 시드.
 * 코드 체계는 개념모델 v2 §1(품목구분·검사유형·창고유형)에서 확정된 값을 따른다.
 */
const SEED = [
  {
    code: 'ITEM_TYPE',
    nameKo: '품목구분',
    nameVi: 'Phân loại hàng hóa',
    sortOrder: 10,
    values: [
      { code: 'RAW', nameKo: '자재', nameVi: 'Nguyên vật liệu', sortOrder: 10 },
      { code: 'SEMI', nameKo: '반제품', nameVi: 'Bán thành phẩm', sortOrder: 20 },
      { code: 'FG', nameKo: '제품', nameVi: 'Thành phẩm', sortOrder: 30 },
      { code: 'MDSE', nameKo: '상품', nameVi: 'Hàng hóa', sortOrder: 40 },
      { code: 'DEV', nameKo: '개발품(시제품)', nameVi: 'Hàng phát triển', sortOrder: 50 },
    ],
  },
  {
    code: 'INSPECTION_TYPE',
    nameKo: '검사유형',
    nameVi: 'Loại kiểm tra',
    sortOrder: 20,
    values: [
      { code: 'IQC', nameKo: '수입검사', nameVi: 'Kiểm tra đầu vào', sortOrder: 10 },
      { code: 'PQC', nameKo: '공정검사', nameVi: 'Kiểm tra công đoạn', sortOrder: 20 },
      { code: 'OQC', nameKo: '출하검사', nameVi: 'Kiểm tra xuất hàng', sortOrder: 30 },
    ],
  },
  {
    code: 'WAREHOUSE_TYPE',
    nameKo: '창고유형',
    nameVi: 'Loại kho',
    sortOrder: 30,
    values: [
      { code: 'MATERIAL', nameKo: '자재창고', sortOrder: 10 },
      { code: 'SEMI', nameKo: '반제품창고', sortOrder: 20 },
      { code: 'PRODUCT', nameKo: '제품창고', sortOrder: 30 },
      { code: 'MDSE', nameKo: '상품창고', sortOrder: 40 },
      { code: 'PRODUCTION', nameKo: '생산창고', sortOrder: 50 },
      { code: 'DEFECT', nameKo: '불량창고', sortOrder: 60 },
      { code: 'REWORK', nameKo: '재작업공간', sortOrder: 70 },
    ],
  },
];

async function main(): Promise<void> {
  for (const group of SEED) {
    const { values, ...groupData } = group;

    await prisma.codeGroup.upsert({
      where: { code: group.code },
      update: { ...groupData, deletedAt: null },
      create: { ...groupData, source: DataSource.MES, createdBy: 'seed', updatedBy: 'seed' },
    });

    for (const value of values) {
      await prisma.codeValue.upsert({
        where: { uq_code_value: { groupCode: group.code, code: value.code } },
        update: { ...value, deletedAt: null },
        create: {
          ...value,
          groupCode: group.code,
          source: DataSource.MES,
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      });
    }

    // eslint-disable-next-line no-console
    console.log(`seeded ${group.code} (${values.length} values)`);
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
