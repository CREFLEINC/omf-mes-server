import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InboundReceiptHeaderWriteInput,
  collectHeaderErrors,
  collectMomentErrors,
  lineRequired,
} from './inbound-receipt-rules';
import { InboundReceiptView, inboundReceiptView } from './inbound-receipt-view';
import { InboundReceiptService } from './inbound-receipt.service';

/** 계약 `InboundReceiptSplitPart` — ⛔ `vehicleNo`·`deliveryNoteAttachmentId` 칸이 «없다»
 *  (등록 본문과 갈린다 · 초과 분리로 간 도착은 차량번호가 유실된다 · R-11 ⓚ). */
export type InboundReceiptSplitPart = Omit<InboundReceiptHeaderWriteInput, 'vehicleNo'>;

export interface InboundReceiptSplitInput {
  mode: 'BOTH' | 'NORMAL_ONLY' | 'EXCESS_ONLY';
  normal?: InboundReceiptSplitPart;
  excess?: InboundReceiptSplitPart;
  /** ⛔ 바깥에서 «한 번만» 받는다 — 두 건이 같은 순간의 한 트랜잭션이기 때문이다(계약). */
  businessDate: string;
  occurredAt: string;
}

/** 요청 순서 그대로다 — 계약이 `created` 의 순서를 안 적었고 지어내지 않는 쪽이 이것이다. */
const SIDES = ['normal', 'excess'] as const;

/**
 * 초과 입하 분리 등록 — 화면 `W-01-03`. 「정량분과 초과분을 **한 트랜잭션**으로 등록한다 …
 * 부분 실패를 허용하지 않는다」(계약).
 *
 * ⛔ 원본을 건드리는 로직이 «없다» — 요청에 원본을 가리키는 칸이 하나도 없고 `W-01-03`
 * §5-1 이 「아직 아무것도 저장되지 않았다」라 적었다. 원 도착은 화면의 미저장 초안이다.
 */
@Injectable()
export class InboundReceiptSplitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly receipts: InboundReceiptService,
  ) {}

  async create(
    input: InboundReceiptSplitInput,
    appUserId: number,
  ): Promise<{ created: InboundReceiptView[] }> {
    const parts = await this.assertWritable(input);

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 1~2회 부른다(§4-3). 두 part 의 `plantId` 가
    //    다를 수 있어 각자의 공장으로 부른다. ⛔ 재시도 루프는 없다 — 카운터가 한 문장이라
    //    동시 등록도 값이 안 겹친다. ⚠ 트랜잭션이 깨지면 뽑아 둔 번호가 결번이 된다.
    const numbers: string[] = [];
    for (const { part } of parts) {
      numbers.push(await this.numbering.next('INBOUND_RECEIPT', BigInt(part.plantId), input.businessDate));
    }

    const ids = await this.prisma.$transaction(
      async (tx) => {
        // ⛔ 두 part 의 부모 P/O 를 «한 번에» 오름차순으로 먼저 잠근다 — part 마다 잠그면
        //    획득 순서가 「normal 집합 → excess 집합」이 되어 동시 등록·치환과 교착한다.
        const parentLineIds = new Set<bigint>();
        for (const { part } of parts) {
          for (const line of part.lines) {
            if (line.purchaseOrderLineId != null) parentLineIds.add(BigInt(line.purchaseOrderLineId));
          }
        }
        if (parentLineIds.size > 0) await this.receipts.lockParentsOf(tx, [...parentLineIds]);

        const created: bigint[] = [];
        for (const [index, { side, part }] of parts.entries()) {
          created.push(await this.receipts.createWithin(tx, numbers[index], part, appUserId, `${side}.`));
        }
        return created;
      },
      // 부모 P/O 잠금이 커밋까지 간다 — 기본 5초를 넘기면 `P2028` 이 500 으로 샌다(R-4).
      { timeout: 15_000, maxWait: 5_000 },
    );

    const rows = await this.prisma.inbound_receipt.findMany({
      where: { inbound_receipt_id: { in: ids } },
      orderBy: { inbound_receipt_id: 'asc' },
    });
    // 두 건이 «한 트랜잭션»에서 차례로 서므로 id 오름차순이 곧 요청 순서(정량분 → 초과분)다.
    return { created: rows.map(inboundReceiptView) };
  }

  /** ⛔ `mode` 와 어긋나게 실린 쪽을 «조용히 버리지 않는다» — 계약이 「목 서버·검증기는 mode 와
   *  어긋나는 조합을 통과시킨다」라 가드가 못 막는 것을 스스로 적었다(§4-1). */
  private async assertWritable(
    input: InboundReceiptSplitInput,
  ): Promise<{ side: (typeof SIDES)[number]; part: InboundReceiptSplitPart }[]> {
    const errors: ErrorItem[] = [];
    for (const side of SIDES) {
      // 「정량분 입하. mode 가 EXCESS_ONLY 가 아니면 필수」·「초과분 … NORMAL_ONLY 가 아니면」(계약).
      const wanted = input.mode !== (side === 'normal' ? 'EXCESS_ONLY' : 'NORMAL_ONLY');
      const part = input[side];
      if (wanted && part === undefined) {
        errors.push(field(side, ERROR_CODE.REQUIRED, `mode 가 ${input.mode} 라 필요합니다.`));
      }
      if (!wanted && part !== undefined) {
        errors.push(field(side, ERROR_CODE.INVALID, `mode 가 ${input.mode} 라 실을 수 없습니다.`));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const parts = SIDES.filter((side) => input[side] !== undefined).map((side) => ({
      side,
      part: input[side] as InboundReceiptSplitPart,
    }));
    for (const { side, part } of parts) {
      if (part.lines.length === 0) errors.push(lineRequired(`${side}.lines`));
    }
    collectMomentErrors(input.businessDate, input.occurredAt, errors);
    // 설계 미정 — 문의 029: 한 물리 공급사 LOT 이 정량분·초과분으로 갈리는 W-01-03 대표
    // 시나리오를 `uq_lot(plant_id, lot_no)` 이 막는다. 계약·화면 스펙이 안 다뤘다 — 화면이
    // 어느 칸을 고칠지 짚도록 미리 400 한다(§2 2단계 「거부하는 쪽」).
    const lotNos = new Set<string>();
    const checks = parts.flatMap(({ side, part }) =>
      collectHeaderErrors(`${side}.`, part, errors, lotNos),
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(this.prisma, checks);
    return parts;
  }
}
