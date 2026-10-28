import { PrismaService } from '../../prisma/prisma.service';

/** 외자발주(직수입) — ERP 발주유형(PO_TYPE_CD). 통관을 거치는 발주는 이것뿐이다(고객 발주유형.xlsx). */
export const IMPORT_ORDER_TYPE = 'PO';

/** 함수 이름이 설정되지 않았으면 `null` — 모듈이 설정(`ERP_CC_FUNCTION`)으로 만든다. */
export const CUSTOMS_LOOKUP = Symbol('CUSTOMS_LOOKUP');

/** 구매입고 `CC_NO` 칸 길이 — 발주 라인 칸도 같다. */
const CC_NO_LENGTH = 18;

export interface CustomsClearance {
  no: string;
  seq: number;
}

/** ERP 함수 `ufn_M_CC_DTL_GetCC` — 외자이고 아직 다 입고되지 않았고 마감되지 않은 발주 라인의 통관번호·순번. */
export interface CustomsLookup {
  find(poNo: string, poSeq: number): Promise<CustomsClearance[]>;
}

export interface CustomsLine {
  purchase_order_line_id: bigint;
  line_no: number;
  erp_customs_clearance_no: string | null;
  erp_customs_clearance_seq: number | null;
  purchase_order: { erp_purchase_order_no: string | null; erp_order_type_code: string | null };
}

export const CUSTOMS_LINE = {
  purchase_order_line_id: true,
  line_no: true,
  erp_customs_clearance_no: true,
  erp_customs_clearance_seq: true,
  purchase_order: { select: { erp_purchase_order_no: true, erp_order_type_code: true } },
} as const;

/** ERP 에 물은 결과 — 하나면 라인에 적었다. 없거나 여럿이면 라인은 그대로다. */
export type CustomsFetch =
  | { result: 'SAVED'; clearance: CustomsClearance }
  | { result: 'NOT_FOUND' }
  | { result: 'MULTIPLE'; candidates: CustomsClearance[] };

const BLANK: CustomsClearance = { no: '', seq: 0 };

/**
 * 외자 발주 라인의 통관번호. ERP 함수로 받아 발주 라인에 적고, 구매입고 행의 `CC_NO`·`CC_SEQ_NO` 에 싣는다.
 * ⭐ 한 발주 라인은 나눠 통관되지 않는다(사용자 2026-10-28) — 한 번 적은 값을 그 라인의 입고마다 쓴다. 함수가 여럿을
 *    돌려주면 그 전제가 깨진 것이라 고르지 않고 사람에게 넘긴다.
 * ⚠ 함수는 ERP 에 전량 입고가 반영되면 빈 결과를 준다 — 그래서 적어 둔 값을 먼저 쓰고, 없을 때만 묻는다.
 */
export class CustomsClearances {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: CustomsLookup | null,
  ) {}

  get enabled(): boolean {
    return this.lookup !== null;
  }

  async fetch(line: CustomsLine): Promise<CustomsFetch> {
    if (this.lookup === null) throw new Error('ERP 통관번호 함수(ERP_CC_FUNCTION)가 설정되지 않았다');
    const poNo = line.purchase_order.erp_purchase_order_no;
    if (poNo === null) throw new Error(`발주 라인 ${line.purchase_order_line_id} 는 ERP 발주가 아니다`);
    const found = await this.lookup.find(poNo, line.line_no);
    if (found.length === 0) return { result: 'NOT_FOUND' };
    if (found.length > 1) return { result: 'MULTIPLE', candidates: found };
    const [clearance] = found;
    if (clearance.no.length > CC_NO_LENGTH) {
      throw new Error(`ERP 발주 ${poNo} 라인 ${line.line_no} 의 통관번호 ${clearance.no} 가 ${CC_NO_LENGTH}자보다 길다`);
    }
    await this.prisma.purchase_order_line.update({
      where: { purchase_order_line_id: line.purchase_order_line_id },
      data: {
        erp_customs_clearance_no: clearance.no,
        erp_customs_clearance_seq: clearance.seq,
        erp_customs_clearance_fetched_at: new Date(),
      },
    });
    return { result: 'SAVED', clearance };
  }

  /** 구매입고 행에 실을 값. 외자인데 하나로 정하지 못하면 던진다 — 그 메시지만 실패로 남고 재처리한다. */
  async forReceipt(line: CustomsLine): Promise<CustomsClearance> {
    if (line.purchase_order.erp_order_type_code !== IMPORT_ORDER_TYPE) return BLANK;
    if (line.erp_customs_clearance_no !== null) {
      return { no: line.erp_customs_clearance_no, seq: line.erp_customs_clearance_seq ?? 0 };
    }
    if (this.lookup === null) return BLANK;
    const at = `외자 발주 ${line.purchase_order.erp_purchase_order_no} 라인 ${line.line_no}`;
    const fetched = await this.fetch(line);
    if (fetched.result === 'NOT_FOUND') throw new Error(`${at} — ERP 에 통관번호가 없다(통관 전이거나 마감·전량 입고)`);
    if (fetched.result === 'MULTIPLE') {
      const list = fetched.candidates.map((c) => `${c.no}/${c.seq}`).join(', ');
      throw new Error(`${at} — 통관번호가 ${fetched.candidates.length}개(${list})다. 나눠 통관된 라인이라 확인이 필요하다`);
    }
    return fetched.clearance;
  }
}
