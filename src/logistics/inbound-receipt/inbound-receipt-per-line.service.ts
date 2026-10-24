import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, field } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { InboundReceiptCreateInput, assertWritable } from './inbound-receipt-rules';
import { InboundReceiptDetail } from './inbound-receipt-view';
import { InboundReceiptService } from './inbound-receipt.service';

/**
 * 줄마다 입하 한 건 — 입하 등록 본문 그대로를 받아 줄 하나씩 입하를 세운다(장부 P-117). 입하번호는 품목마다 하나다
 * (사용자 결정 2026-10-24 — 일괄 입하와 한 품목씩 입하의 번호 기준을 맞춘다). 헤더 값은 모든 건이 같다.
 * 모든 건이 «한 트랜잭션»이다 — 하나라도 막히면 아무것도 서지 않는다(일괄 입하의 「함께 들어가거나 함께 되돌아온다」).
 */
@Injectable()
export class InboundReceiptPerLineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly receipts: InboundReceiptService,
  ) {}

  async create(input: InboundReceiptCreateInput, actor: LogisticsWriteActor): Promise<{ created: InboundReceiptDetail[] }> {
    // 줄이 여럿인 본문 그대로 검사한다 — 400 이 `lines.{i}.…` 를 짚는다. 줄이 없으면 여기서 LINE_REQUIRED 다.
    await assertWritable(this.prisma, input);
    const parts = input.lines.map((line) => ({ ...input, lines: [line] }));

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 줄 수만큼 부른다(등록·분리와 같다). 깨지면 뽑아 둔 번호는 결번이 된다.
    const numbers: string[] = [];
    const iqcRequestNos: (string | undefined)[][] = [];
    for (const part of parts) {
      numbers.push(await this.numbering.next('INBOUND_RECEIPT', BigInt(input.plantId), input.businessDate));
      iqcRequestNos.push(await this.receipts.allocateIqcRequestNos(part, input.businessDate));
    }

    const ids = await this.prisma.$transaction(
      async (tx) => {
        // ⛔ 모든 건의 부모 P/O 를 «한 번에» 오름차순으로 먼저 잠근다 — 건마다 잠그면 동시 등록·치환과 교착한다.
        const parentLineIds = [
          ...new Set(input.lines.flatMap((line) => (line.purchaseOrderLineId == null ? [] : [BigInt(line.purchaseOrderLineId)]))),
        ];
        if (parentLineIds.length > 0) await this.receipts.lockParentsOf(tx, parentLineIds);
        const created: bigint[] = [];
        for (const [index, part] of parts.entries()) {
          created.push(await withLineIndex(index, () =>
            this.receipts.createWithin(tx, numbers[index], part, actor, '', input.businessDate, iqcRequestNos[index], input.occurredAt),
          ));
        }
        return created;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
    const created: InboundReceiptDetail[] = [];
    for (const id of ids) created.push((await this.receipts.read(Number(id))).detail);
    return { created };
  }
}

/**
 * 건마다 줄이 하나라 `createWithin` 의 400(P/O 한도·없는 P/O 라인 등)은 `lines.0.…` 을 짚는다 — 요청의 그 줄
 * `lines.{i}.…` 로 옮겨 적는다. 같은 P/O 라인의 줄 여럿이 한도를 넘으면 넘친 첫 줄을 짚는다(앞 건이 이미 올렸다).
 */
async function withLineIndex<T>(index: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ContractException) || index === 0) throw error;
    throw new ContractException(
      HttpStatus.BAD_REQUEST,
      error.errors.map((item) =>
        item.scope === 'field' && item.field?.startsWith('lines.0.')
          ? field(`lines.${index}.${item.field.slice('lines.0.'.length)}`, item.code, item.message)
          : item,
      ),
    );
  }
}
