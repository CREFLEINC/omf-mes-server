import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CUSTOMS_LINE,
  CUSTOMS_LOOKUP,
  CustomsClearance,
  CustomsClearances,
  CustomsLookup,
  IMPORT_ORDER_TYPE,
} from './customs-clearance';

export interface CustomsFetchLine {
  purchaseOrderLineId: number;
  lineNo: number;
  /** SAVED = 하나라 적었다 · NOT_FOUND = ERP 에 없다(적힌 값은 그대로) · MULTIPLE = 여럿이라 적지 않았다. */
  result: 'SAVED' | 'NOT_FOUND' | 'MULTIPLE';
  customsClearanceNo: string | null;
  customsClearanceSeq: number | null;
  candidates: { customsClearanceNo: string; customsClearanceSeq: number }[];
}

export interface CustomsFetchResult {
  purchaseOrderId: number;
  lines: CustomsFetchLine[];
}

/** 「ERP 연동 현황·이력 > 구매 발주」의 [통관번호 받아오기] — 외자 발주의 라인마다 ERP 함수를 부른다. */
@Injectable()
export class CustomsClearanceService {
  private readonly clearances: CustomsClearances;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CUSTOMS_LOOKUP) lookup: CustomsLookup | null,
  ) {
    this.clearances = new CustomsClearances(prisma, lookup);
  }

  async fetchOrder(purchaseOrderId: number): Promise<CustomsFetchResult> {
    const order = await this.prisma.purchase_order.findUnique({
      where: { purchase_order_id: BigInt(purchaseOrderId) },
      select: {
        erp_purchase_order_no: true,
        erp_order_type_code: true,
        purchase_order_line: { where: { cancelled_at: null }, orderBy: { line_no: 'asc' }, select: CUSTOMS_LINE },
      },
    });
    if (order === null) throw new NotFoundException('없는 발주입니다.');
    if (order.erp_purchase_order_no === null || order.erp_order_type_code !== IMPORT_ORDER_TYPE) {
      throw locked('외자 발주(발주유형 PO)만 통관번호를 받아 옵니다.');
    }
    if (!this.clearances.enabled) throw locked('이 서버는 ERP 통관번호 조회가 설정되어 있지 않습니다.');

    const lines: CustomsFetchLine[] = [];
    for (const line of order.purchase_order_line) {
      const fetched = await this.clearances.fetch(line);
      const kept: CustomsClearance | null =
        fetched.result === 'SAVED'
          ? fetched.clearance
          : line.erp_customs_clearance_no === null
            ? null
            : { no: line.erp_customs_clearance_no, seq: line.erp_customs_clearance_seq ?? 0 };
      lines.push({
        purchaseOrderLineId: Number(line.purchase_order_line_id),
        lineNo: line.line_no,
        result: fetched.result,
        customsClearanceNo: kept?.no ?? null,
        customsClearanceSeq: kept?.seq ?? null,
        candidates:
          fetched.result === 'MULTIPLE'
            ? fetched.candidates.map((c) => ({ customsClearanceNo: c.no, customsClearanceSeq: c.seq }))
            : [],
      });
    }
    return { purchaseOrderId, lines };
  }
}

function locked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
}
