import { Prisma } from '@prisma/client';

/** ERP 창고는 공통코드 그룹 `SL_TYPE`(창고구분)으로 온다. 그 코드의 MES 창고가 「ERP 창고」다(장부 P-148). */
export const ERP_WAREHOUSE_GROUP = 'SL_TYPE';

/** ERP 창고면 ERP 이름, 아니면 null. ERP 에서 끈 코드도 ERP 창고다 — 이름은 계속 ERP 를 따른다. */
export async function erpWarehouseName(
  prisma: Pick<Prisma.TransactionClient, 'code_value'>,
  code: string,
): Promise<string | null> {
  const row = await prisma.code_value.findFirst({
    where: { code, code_group: { group_code: ERP_WAREHOUSE_GROUP } },
    select: { code_name: true },
  });
  return row?.code_name ?? null;
}
