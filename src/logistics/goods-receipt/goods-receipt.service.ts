import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { IF_GOODS_RECEIPT, OutboxService, outboxMessageKey } from '../../core/outbox';
import { ConflictException, ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { LogisticsWriteActor } from '../logistics-write-actor';
import {
  GoodsReceiptDetail,
  GoodsReceiptLineView,
  GoodsReceiptView,
  LINE_INCLUDE,
  receiptLineView,
  receiptView,
} from './goods-receipt-view';
import { MATERIAL_RECEIPT, erpInboundLines } from './erp-receipt';
import { inboundLineOfLot, receivableQtyOf } from './lot-receivable';
import { GoodsReceiptCreate, postReceipt } from './receipt-posting';

/**
 * 입고 — 원장에 «쓰는» 첫 도메인. 화면은 `W-01-10`(입고 처리)이 소유하고
 * `M-04-04`·`W-04-06` 도 같은 오퍼레이션을 부른다.
 *
 * ⛔ 서버가 정하는 것이 거의 없다. 어디에 잡을지(`warehouseId` + `destinationLocationId`),
 * 어느 상태로 잡을지(`qualityStatusCode`·`inventoryStatusCode`), 영업일(`businessDate`)을
 * **전부 화면이 보낸다.** 서버가 짓는 것은 번호 둘과 적치 권장 위치뿐이다.
 */

/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다 — LOT 과 같은 판정이다. */
const NUMBER_RETRY = 3;
const GOODS_RECEIPT_TARGET = 'GOODS_RECEIPT';
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
/** IQC 합격 확정이 LOT 을 옮기는 상태(시드 `LOT_STATUS` · 전이 C4). */
const IQC_PASSED_LOT_STATUS = 'NORMAL';
/** IQC 불합격 확정(C6)이 LOT 을 옮기는 상태 — 불량창고 입고만 허용한다(P-45). */
const DEFECTIVE_LOT_STATUS = 'DEFECTIVE';

export interface GoodsReceiptQuery {
  receiptDateFrom?: string;
  receiptDateTo?: string;
  warehouseId?: number;
  plantId?: number;
  receiptTypeCode?: string;
  statusCode?: string;
  q?: string;
  page?: number;
  size?: number;
}

@Injectable()
export class GoodsReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly outbox: OutboxService,
  ) {}

  async list(query: GoodsReceiptQuery): Promise<PagedResponse<GoodsReceiptView>> {
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const where: Prisma.goods_receiptWhereInput = {
      ...filter('warehouse_id', id('warehouseId', query.warehouseId)),
      ...filter('plant_id', id('plantId', query.plantId)),
      ...filter('receipt_type_code', query.receiptTypeCode),
      ...filter('status_code', query.statusCode),
      ...receiptDateWhere(query.receiptDateFrom, query.receiptDateTo),
      // 「입고번호 검색」(계약) — 사람이 전표에 적힌 번호 일부를 친다.
      ...(query.q === undefined
        ? {}
        : { goods_receipt_no: { contains: query.q, mode: 'insensitive' } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.goods_receipt.findMany({
        where,
        orderBy: [{ receipt_datetime: 'desc' }, { goods_receipt_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.goods_receipt.count({ where }),
    ]);
    const queued = await this.erpQueued(rows.map((row) => row.goods_receipt_id));
    return pagedResponse(
      rows.map((row) => receiptView(row, queued.has(row.goods_receipt_id))),
      total,
      page,
    );
  }

  async get(goodsReceiptId: number): Promise<{ detail: GoodsReceiptDetail; versionNo: number }> {
    const row = await this.prisma.goods_receipt.findUnique({
      where: { goods_receipt_id: goodsReceiptId },
    });
    if (!row) throw new NotFoundException('없는 입고 전표입니다.');
    return {
      detail: {
        goodsReceipt: receiptView(row, (await this.erpQueued([row.goods_receipt_id])).has(row.goods_receipt_id)),
        lines: await this.lines(goodsReceiptId),
      },
      versionNo: row.version_no,
    };
  }

  async lines(goodsReceiptId: number): Promise<GoodsReceiptLineView[]> {
    const rows = await this.prisma.goods_receipt_line.findMany({
      where: { goods_receipt_id: goodsReceiptId },
      include: LINE_INCLUDE,
      orderBy: { line_no: 'asc' },
    });
    return rows.map(receiptLineView);
  }

  async create(input: GoodsReceiptCreate, actorOrUser: LogisticsWriteActor | number): Promise<GoodsReceiptDetail> {
    const actor: LogisticsWriteActor = typeof actorOrUser === 'number' ? { appUserId: actorOrUser } : actorOrUser;
    await this.assertWritable(input);

    for (let attempt = 0; ; attempt += 1) {
      try {
        // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 열린 트랜잭션 안에서 부르면 한
        //    요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2.md R-2).
        //    적치 지시는 라인마다 하나라 `PUTAWAY_TASK` 는 라인 수만큼 부른다.
        const plantId = BigInt(input.plantId);
        const receiptNo = await this.numbering.next('GOODS_RECEIPT', plantId, input.businessDate);
        const putawayNos: string[] = [];
        for (let line = 0; line < input.lines.length; line += 1) {
          putawayNos.push(await this.numbering.next('PUTAWAY_TASK', plantId, input.businessDate));
        }
        const goodsReceiptId = await this.prisma.$transaction(async (tx) => {
          const id = await postReceipt(tx, this.posting, input, actor.appUserId, receiptNo, putawayNos);
          // ⭐ 적재는 본 트랜잭션의 꼬리다(계약 §5-4 다섯째) — 단독이면 「입고됐는데 적재가 안 된」 창이 열린다.
          if (await this.goesToErp(tx, input)) {
            await this.outbox.enqueue(tx, {
              interfaceCode: IF_GOODS_RECEIPT,
              messageKey: outboxMessageKey(IF_GOODS_RECEIPT, receiptNo),
              targetTypeCode: GOODS_RECEIPT_TARGET,
              targetId: id,
              payload: { goodsReceiptNo: receiptNo },
            });
          }
          if (actor.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
            actor: actor.terminalAudit, targetTypeCode: 'GOODS_RECEIPT', targetId: id, eventTypeCode: 'CREATE',
          });
          return id;
        });
        return (await this.get(Number(goodsReceiptId))).detail;
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '입고번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /**
   * ERP 구매입고로 갈 입고인가(장부 P-104) — 자재 입고이고, 불량창고가 아니고(IQC 불합격분 · 고객 질문 8 전까지
   * 합격 입고만), ERP 발주에 이어진 줄이 하나라도 있다. 줄을 고르는 일은 보낼 때 바꾸개가 다시 한다.
   */
  private async goesToErp(tx: Prisma.TransactionClient, input: GoodsReceiptCreate): Promise<boolean> {
    if (input.receiptTypeCode !== MATERIAL_RECEIPT) return false;
    const warehouse = await tx.warehouse.findUnique({
      where: { warehouse_id: BigInt(input.warehouseId) },
      select: { is_defect: true },
    });
    if (warehouse === null || warehouse.is_defect) return false;
    const lines = input.lines.map((line) => ({
      lotId: BigInt(line.lotId),
      inboundReceiptLineId: line.inboundReceiptLineId == null ? null : BigInt(line.inboundReceiptLineId),
    }));
    return (await erpInboundLines(tx, lines)).some((inboundLineId) => inboundLineId !== null);
  }

  /** ERP 송신 대기열에 적재된 입고 — 적재이지 전송이 아니다(계약 `erpMessageQueued`). */
  private async erpQueued(goodsReceiptIds: bigint[]): Promise<Set<bigint>> {
    if (goodsReceiptIds.length === 0) return new Set();
    const rows = await this.prisma.integration_message.findMany({
      where: {
        interface_code: IF_GOODS_RECEIPT,
        target_type_code: GOODS_RECEIPT_TARGET,
        target_id: { in: goodsReceiptIds },
      },
      select: { target_id: true },
    });
    return new Set(rows.map((row) => row.target_id));
  }

  /**
   * ⛔ 없는 id 를 그냥 넘기면 FK 위반이 **500** 으로 샌다. 원장까지 열고 나서 터지므로
   * 여기서 먼저 본다 — 트랜잭션 밖의 읽기라 값이 그 사이 사라지면 FK 가 최종 방어다.
   */
  private async assertWritable(input: GoodsReceiptCreate): Promise<void> {
    const errors: ErrorItem[] = [];
    // 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다.
    if (input.lines.length === 0) {
      errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '입고 라인이 1건 이상이어야 합니다.'));
    }
    // 「가리킬 문서가 없으면 둘을 함께 비운다 — 한쪽만 채우지 않는다」(계약 · 공유계약 A-10).
    const hasType = input.sourceDocumentTypeCode != null;
    const hasId = input.sourceDocumentId != null;
    if (hasType !== hasId) {
      errors.push(
        field('sourceDocumentTypeCode', ERROR_CODE.PAIR, '원천 문서 유형과 식별자는 짝입니다.'),
      );
    }
    if (Number.isNaN(Date.parse(input.receiptDatetime))) {
      errors.push(field('receiptDatetime', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
      errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await this.assertTargets(input);
    await assertCodeValues(this.prisma, [
      { field: 'receiptTypeCode', value: input.receiptTypeCode, groupCode: 'RECEIPT_TYPE' },
      { field: 'reasonCode', value: input.reasonCode, groupCode: 'GOODS_RECEIPT_REASON' },
      ...input.lines.map((line) => ({
        field: 'lines.qualityStatusCode',
        value: line.qualityStatusCode,
        groupCode: 'LOT_STATUS',
      })),
    ]);
  }

  private async assertTargets(input: GoodsReceiptCreate): Promise<void> {
    const errors: ErrorItem[] = [];
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: input.warehouseId },
      select: { plant_id: true },
    });
    if (!warehouse) {
      errors.push(field('warehouseId', ERROR_CODE.INVALID, '없는 창고입니다.'));
    } else if (Number(warehouse.plant_id) !== input.plantId) {
      // 창고가 다른 공장 것이면 잔량의 조직 축이 전표와 어긋난다 — posting 이 창고에서
      // 조직을 읽으므로 어긋난 채로도 «전기는 된다». 그래서 여기서 막는다.
      errors.push(field('warehouseId', ERROR_CODE.INVALID, '이 공장의 창고가 아닙니다.'));
    }
    const plant = await this.prisma.plant.findUnique({
      where: { plant_id: input.plantId },
      select: { plant_id: true },
    });
    if (!plant) errors.push(field('plantId', ERROR_CODE.INVALID, '없는 공장입니다.'));

    // 같은 LOT 이 여러 줄이면 상한은 줄마다가 아니라 «LOT 합계»로 본다(#108 리뷰 m2).
    const lotTotals = new Map<number, Prisma.Decimal>();
    for (const line of input.lines) {
      lotTotals.set(line.lotId, (lotTotals.get(line.lotId) ?? new Prisma.Decimal(0)).plus(line.receiptQty));
    }
    for (const [index, line] of input.lines.entries()) {
      await this.assertLine(input.warehouseId, index, line, errors, lotTotals.get(line.lotId) as Prisma.Decimal);
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async assertLine(
    warehouseId: number,
    index: number,
    line: GoodsReceiptCreate['lines'][number],
    errors: ErrorItem[],
    lotTotal: Prisma.Decimal,
  ): Promise<void> {
    const at = `lines[${index}]`;
    const [lot, uom, location] = await Promise.all([
      this.prisma.lot.findUnique({
        where: { lot_id: line.lotId },
        select: { item_id: true, status_code: true, source_type_code: true, source_id: true },
      }),
      this.prisma.uom.findUnique({ where: { uom_id: line.uomId }, select: { uom_id: true } }),
      // ⛔ 목적지는 «그 창고의» 위치여야 한다 — 남의 창고 위치에 전기하면 잔량 차원이
      //    창고와 위치가 서로 다른 곳을 가리키는 행이 된다.
      this.prisma.location.findFirst({
        where: { location_id: line.destinationLocationId, warehouse_id: warehouseId },
        select: { location_id: true },
      }),
    ]);
    if (!uom) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
    if (!location) {
      errors.push(field(`${at}.destinationLocationId`, ERROR_CODE.INVALID, '이 창고의 위치가 아닙니다.'));
    }
    if (!lot) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
      return;
    }
    // LOT 과 품목이 어긋나면 원장이 거짓을 적는다 — 계보가 그 두 축으로 이어진다.
    if (Number(lot.item_id) !== line.itemId) {
      errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '이 LOT 의 품목이 아닙니다.'));
    }
    // 입하에서 온 LOT — 선별로 떼어 낸 자식(`LOT_SPLIT`)은 조상의 입하 라인을 따른다(장부 P-56).
    const inboundLineId =
      lot.source_type_code === INBOUND_LOT_SOURCE
        ? lot.source_id
        : lot.source_type_code === LOT_SPLIT_SOURCE
          ? await inboundLineOfLot(this.prisma, BigInt(line.lotId))
          : null;
    if (inboundLineId !== null) await this.assertReceivable(line, at, errors, lotTotal);
    // IQC 대상 입하 LOT 은 합격(LOT 정상) 전에 입고하지 않는다(omf-all-around#100 · C17).
    // 대상 여부는 입하 라인의 표식으로 본다 — 무검사 품목 LOT 은 이 검사를 타지 않는다.
    if (inboundLineId !== null && lot.status_code !== IQC_PASSED_LOT_STATUS) {
      const inbound = await this.prisma.inbound_receipt_line.findUnique({
        where: { inbound_receipt_line_id: inboundLineId },
        select: { inspection_required: true },
      });
      if (inbound?.inspection_required === true) {
        // ⭐ 예외: IQC 불합격(LOT 불량)은 «불량창고»로만 입고할 수 있다(omf-all-around#84 · 2026-10-16 결정 · 장부 P-45) —
        //    불합격 자재를 불량창고로 옮겨 처분·반품을 기다린다. 일반 창고는 계속 막는다. 검사 대기는 어디로도 안 된다.
        const toDefectWarehouse =
          lot.status_code === DEFECTIVE_LOT_STATUS &&
          (await this.prisma.warehouse.findUnique({ where: { warehouse_id: warehouseId }, select: { is_defect: true } }))
            ?.is_defect === true;
        if (!toDefectWarehouse) {
          errors.push(
            field(
              `${at}.lotId`,
              ERROR_CODE.STATE_LOCKED,
              lot.status_code === DEFECTIVE_LOT_STATUS
                ? 'IQC 불합격 LOT 은 불량창고로만 입고할 수 있습니다.'
                : 'IQC 수입검사 합격 전인 LOT 은 입고할 수 없습니다.',
            ),
          );
        }
      }
    }
  }

  /**
   * 입고 상한(장부 P-56) — 입하 LOT 은 «입고 가능 수량»까지만 입고한다. 선별로 떼어 낸 불량분(자식 LOT)과 이미 입고한 수량을 뺀 값이다.
   * 비교 대상은 이 요청 안 같은 LOT 줄의 합계다(`lotTotal`).
   * ⚠ 전기 트랜잭션 밖의 확인이다(이 파일의 다른 검사와 같다) — 같은 LOT 을 동시에 두 번 입고하면 둘 다 통과할 수 있다.
   */
  private async assertReceivable(
    line: GoodsReceiptCreate['lines'][number],
    at: string,
    errors: ErrorItem[],
    lotTotal: Prisma.Decimal,
  ): Promise<void> {
    const receivable = (await receivableQtyOf(this.prisma, [BigInt(line.lotId)])).get(BigInt(line.lotId));
    if (receivable === undefined || receivable.greaterThanOrEqualTo(lotTotal)) return;
    errors.push(
      field(
        `${at}.receiptQty`,
        ERROR_CODE.INVALID,
        `이 LOT 은 ${receivable.toString()} 까지 입고할 수 있습니다(선별로 떼어 낸 불량분·이미 입고한 수량 제외).`,
      ),
    );
  }
}

/**
 * 「입고일」로 거른다. 저장 칸은 `timestamptz` 라 하루의 경계를 정해야 한다.
 *
 * ⚠ **UTC 경계**로 자른다. 서버·컨테이너·DB 가 UTC 고정이고, 공장 로컬 하루로 자르려면
 * `plant.timezone_code` 가 필요한데 이 질의는 공장을 «선택»으로만 받는다 — 공장 없이 부르면
 * 로컬 경계를 풀 수 없다. 날짜 타임존 캐스팅을 지어내지 않는다.
 */
function receiptDateWhere(from?: string, to?: string): Prisma.goods_receiptWhereInput {
  if (from === undefined && to === undefined) return {};
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
  const end = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return {
    receipt_datetime: {
      ...(start === undefined ? {} : { gte: start }),
      ...(end === undefined ? {} : { lt: end }),
    },
  };
}

/** `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return (
    Array.isArray(target) &&
    target.some((column) => ['goods_receipt_no', 'putaway_task_no', 'transaction_no'].includes(String(column)))
  );
}

function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}

function filter<T>(column: string, value: T | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [column]: value };
}

function number(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 숫자 축에 글자가 섞이면 400 이다 — 그냥 넘기면 Prisma 검증 오류가 500 으로 샌다. */
function id(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field(name, ERROR_CODE.INVALID, '숫자 식별자여야 합니다.'),
  ]);
}
