import { ConflictException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { isShipmentOqc } from './oqc-lot-result';

/** 계약 `QualityConflictResponse.code` — 출하 OQC 새 흐름은 확정 버튼이 없다(피처 010 R-5). */
export const CONFIRMED_BY_SHIPMENT_COMPLETION = 'CONFIRMED_BY_SHIPMENT_COMPLETION';

const MESSAGE = '출하 검사 결과는 출하 완료 때 함께 확정됩니다 — 따로 확정하지 않습니다.';

export function shipmentOqcConfirmConflict(): ConflictException {
  return new ConflictException('user', MESSAGE, { code: CONFIRMED_BY_SHIPMENT_COMPLETION });
}

/**
 * 컨트롤러 진입 가드 — 새 흐름 OQC 의뢰·결과의 `:confirm` 은 409(확정은 출하 완료가 한다). 확정 서비스
 * (`inspection-confirm.service.ts`·`iqc-request-confirm.service.ts`)는 고치지 않는다. 없는 id 는 그 서비스가 404 로 막는다.
 */
export async function assertNotShipmentOqcConfirm(
  prisma: PrismaService,
  target: { inspectionRequestId: number } | { inspectionResultId: number },
): Promise<void> {
  const select = { inspection_type_code: true, target_type_code: true, lot_id: true };
  const request = 'inspectionRequestId' in target
    ? await prisma.inspection_request.findUnique({ where: { inspection_request_id: target.inspectionRequestId }, select })
    : (await prisma.inspection_result.findUnique({
        where: { inspection_result_id: target.inspectionResultId },
        select: { inspection_request: { select } },
      }))?.inspection_request ?? null;
  if (request !== null && isShipmentOqc(request)) throw shipmentOqcConfirmConflict();
}
