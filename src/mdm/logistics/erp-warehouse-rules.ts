import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { erpWarehouseName } from '../../common/master';

/**
 * ERP 창고의 코드·이름은 ERP 가 정한다(사용자 결정 2026-10-29 · 장부 P-148). 이름은 ERP 이름이어야 하고 — 현장 이름은
 * 별칭에 둔다 — ERP 코드 하나에 MES 창고는 하나다(공장이 달라도). `current` 는 수정 때의 지금 값이다.
 */
export async function assertErpWarehouse(
  prisma: Pick<Prisma.TransactionClient, 'code_value' | 'warehouse'>,
  input: { warehouseCode: string; warehouseName: string },
  current: { warehouseId: bigint; warehouseCode: string } | null,
): Promise<void> {
  const errors: ErrorItem[] = [];
  const currentName = current === null ? null : await erpWarehouseName(prisma, current.warehouseCode);
  const codeChanged = current === null || current.warehouseCode !== input.warehouseCode;
  if (currentName !== null && codeChanged) {
    errors.push(field('warehouseCode', ERROR_CODE.STATE_LOCKED, 'ERP 창고의 코드는 고칠 수 없습니다.'));
  }
  const targetName = codeChanged ? await erpWarehouseName(prisma, input.warehouseCode) : currentName;
  // 지금 ERP 창고면 코드를 바꿔 보내도 이름은 그 ERP 이름이어야 한다.
  const erpName = currentName ?? targetName;
  if (erpName !== null && input.warehouseName !== erpName) {
    errors.push(field('warehouseName', ERROR_CODE.STATE_LOCKED, 'ERP 창고 이름은 ERP 를 따릅니다 — 현장 이름은 별칭에 둡니다.'));
  }
  if (targetName !== null) {
    const other = await prisma.warehouse.findFirst({
      where: {
        warehouse_code: input.warehouseCode,
        ...(current === null ? {} : { NOT: { warehouse_id: current.warehouseId } }),
      },
      select: { warehouse_id: true },
    });
    if (other !== null) {
      errors.push({
        scope: 'field', field: 'warehouseCode', code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['warehouseCode'], message: 'ERP 창고 하나에 MES 창고는 하나입니다 — 다른 공장에 이미 있습니다.',
      });
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
