import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { omitEmpty } from '../../common/http/omit-empty';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import {
  ExternalIdentifierInput,
  LotRegisterInput,
  LotRegisterActor,
  LotRegistryService,
  nextInboundMaterialLotNo,
  optionalDay,
  optionalInstant,
} from '../../core/lot';
import { LIVE_ALLOCATION } from '../../core/lot/lot-allocation';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertDay,
  assertId,
  assertInstant,
  assertNumberSource,
  bool,
  completedWhere,
  CURRENT_LOT_WHERE,
  duplicateLotNo,
  expiryWhere,
  isDuplicateLotNo,
  loose,
  optional,
  pickCurrentLot,
  workOrderWhere,
} from './lot-rules';
import { LotProgressView, lotProgress } from './lot-progress';
import { type FourMChangeRow, fourMChangeView } from '../../quality/inspection/four-m-change';
import { LotDetail, LotRow, LotView, holdView, identifierView, lotView } from './lot-view';
import type { LotWriteActor } from './lot-write-actor';

/**
 * LOT — 추적성의 뿌리. 화면은 `M-01-02`(자재LOT 스캔등록)·`P-01-01`(LOT 등록·라벨발행)이
 * 만들고, 여러 화면이 읽는다.
 *
 * ⭐ 등록이 하는 일이 셋이다 — 번호를 얻고, 외부 식별자를 붙이고, **서버가 스스로 보류를
 * 건다**(「자재 LOT 은 등록 즉시 검사 대기로 보류된다 — 화면이 보내지 않고 서버가 건다」
 * MLOT #5). 셋이 한 트랜잭션이다.
 *
 * ⛔ **재고는 여기서 잡지 않는다.** 계약이 「재고는 즉시 잡히되 가용이 아니다」라 적었으나
 * `LotCreate` 에 창고·로케이션이 없어 «어디에» 잡을지 알 수 없다. 원장 기록은 창고를 아는
 * 입고가 진다 — 되돌림 §Z-2.
 */

/** 계약이 이 경로로 오는 원천을 하나로 닫았다. */
const SOURCE_TYPES = ['INBOUND_RECEIPT_LINE'];
const MES_RETRY = 3;
const MATERIAL_LOT_TYPE = 'MATERIAL';
const SUPPLIER_LOT_IDENTIFIER = 'SUPPLIER_LOT';

type InboundMesSource = Prisma.inbound_receipt_lineGetPayload<{
  include: { inbound_receipt: true };
}>;

export type { ExternalIdentifierInput };

/** 코어가 받는 칸(`LotRegisterInput`)에 이 경로만 쓰는 넷을 더한 것이다. */
export interface LotCreate extends Omit<LotRegisterInput, 'lotNo' | 'incomingIqc'> {
  numberSourceCode?: string;
  /** ⚠ 코어와 달리 «없을 수» 있다 — MES 채번은 서버가 뒤에 매긴다. */
  lotNo?: string;
  businessDate: string;
  occurredAt: string;
}

/** 계약 `LotUpdate` — 번호·품목·공장은 못 바꾼다. */
export interface LotUpdate {
  initialQty: number;
  manufacturedAt?: string | null;
  expiryDate?: string | null;
  remarks?: string | null;
}

export interface LotQuery {
  itemId?: number;
  plantId?: number;
  lotTypeCode?: string;
  statusCode?: string;
  heldOnly?: boolean | string;
  expiryDateFrom?: string;
  expiryDateTo?: string;
  lotNo?: string;
  q?: string;
  workOrderId?: number;
  completed?: boolean | string;
  unreceivedOnly?: boolean | string;
  awaitingReceiptOnly?: boolean | string;
  currentOnly?: boolean | string;
  page?: number;
  size?: number;
}

@Injectable()
export class LotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: LotRegistryService,
    private readonly numbering: NumberingService,
  ) {}

  async list(query: LotQuery): Promise<PagedResponse<LotView>> {
    const page = pageRequest({
      page: loose(query.page),
      size: loose(query.size),
    });
    const currentOnly = bool(query.currentOnly) === true;
    if (currentOnly && query.workOrderId === undefined) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('workOrderId', ERROR_CODE.REQUIRED, '현재 생산 LOT 을 보려면 MES W/O 를 먼저 고르세요.'),
      ]);
    }
    const base: Prisma.lotWhereInput = {
      ...optional('item_id', assertId('itemId', query.itemId)),
      ...optional('plant_id', assertId('plantId', query.plantId)),
      ...optional('lot_type_code', query.lotTypeCode),
      ...optional('status_code', query.statusCode),
      // 「LOT 번호 정확 일치. 스캔 화면이 쓴다」(계약) — 부분 검색으로는 한 건을 못 집는다.
      ...optional('lot_no', query.lotNo),
      ...expiryWhere(query.expiryDateFrom, query.expiryDateTo),
      ...workOrderWhere(assertId('workOrderId', query.workOrderId)),
      ...completedWhere(bool(query.completed)),
      ...(bool(query.heldOnly) === true ? { lot_hold: { some: { released_at: null } } } : {}),
      ...(query.q === undefined
        ? {}
        : {
            // 「LOT 번호·외부 식별자 검색」(계약) — 둘을 함께 본다.
            OR: [
              { lot_no: { contains: query.q, mode: 'insensitive' } },
              {
                lot_external_identifier: {
                  some: {
                    external_identifier: {
                      contains: query.q,
                      mode: 'insensitive',
                    },
                  },
                },
              },
            ],
          }),
    };

    // ⛔ 펼쳐 합치지 않는다 — 같은 칸(`completed_at`·`lot_type_code`)을 쓰는 질의가 후보 조건을 덮어써 완료·비생산 LOT 이 현재가 된다.
    const where: Prisma.lotWhereInput = currentOnly ? { AND: [base, CURRENT_LOT_WHERE] } : base;

    // 목록의 `lotView` 는 보류를 `some()` 불리언으로만 쓴다 — 순서가 나가지 않아 정렬하지 않는다.
    const include = { lot_hold: true, lot_four_m_change: { select: { change_type_code: true, remarks: true } } } as const;
    if (currentOnly) {
      // 한 W/O 의 선발행 슬롯만이라 후보가 적다 — 다 읽고 고른다. 받은 쪽(page·size)은 보지 않고 1쪽·1건으로 답한다.
      const current = pickCurrentLot(await this.prisma.lot.findMany({ where, include }));
      const items = current === undefined ? [] : [current];
      return pagedResponse(
        items.map((row) => omitEmpty({ ...lotView(row), fourMChange: fourMChangeView(row.lot_four_m_change) })),
        items.length,
        pageRequest({ page: 1, size: 1 }),
      );
    }
    const [rows, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        include,
        orderBy: [{ created_at: 'desc' }, { lot_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.lot.count({ where }),
    ]);
    return pagedResponse(
      rows.map((row) => omitEmpty({ ...lotView(row), fourMChange: fourMChangeView(row.lot_four_m_change) })),
      total,
      page,
    );
  }

  /** `withProgress` 는 **단건에만** 있다 — 계약이 ⌜목록에서는 LOT 마다 세게 되므로 기본은 끈다⌝. */
  async get(lotId: number, withProgress = false): Promise<{ detail: LotDetail; versionNo: number }> {
    const row = await this.row(lotId);
    const identifiers = await this.prisma.lot_external_identifier.findMany({
      where: { lot_id: lotId },
      orderBy: { lot_external_identifier_id: 'asc' },
    });
    return {
      detail: {
        lot: omitEmpty({
          ...lotView(row),
          ...(withProgress ? { progress: await this.progress(row) } : {}),
          fourMChange: fourMChangeView(row.lot_four_m_change),
        }),
        externalIdentifiers: identifiers.map(identifierView),
        // 「해제되지 않은 보류를 함께 내린다」(계약) — 푼 것은 이력이지 지금 상태가 아니다.
        holds: row.lot_hold.filter((h) => h.released_at === null).map((h) => holdView(h, row)),
      },
      versionNo: row.version_no,
    };
  }

  /**
   * ⚠ 201 이 돌려주는 것은 `Lot` 이 아니라 **`LotDetailResponse`** 다 — 등록이 외부
   * 식별자와 보류를 «함께» 만들므로 그 셋을 한 번에 보인다(계약).
   */
  async create(input: LotCreate, actor: number | LotWriteActor): Promise<LotDetail> {
    const registerActor: LotRegisterActor = typeof actor === 'number' ? actor
      : actor.appUserId !== undefined ? actor.appUserId
      : { workerId: actor.terminalAudit.workerId, terminalAudit: actor.terminalAudit };
    const source = assertNumberSource(input);
    const inboundSource = source === 'MES' ? await this.inboundMesSource(input.sourceId) : undefined;
    const effectiveInput = inboundSource === undefined ? input : this.fromInboundSource(input, inboundSource);
    await this.assertWritable(effectiveInput);
    // ⭐ IQC 의뢰는 번호 출처와 상관없이 입하 라인의 검사 여부를 따른다 — SUPPLIER(사전부착)도
    //    MES 와 같이 의뢰를 만든다. 안 만들면 보류만 걸리고 검사할 의뢰가 없다(omf-all-around#18).
    const iqcSource = inboundSource ?? (await this.inboundLine(input.sourceId));
    const iqcRequestNo =
      iqcSource?.inspection_required === true
        ? await this.numbering.next('INSPECTION_REQUEST', iqcSource.inbound_receipt.plant_id, input.businessDate)
        : undefined;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const row =
          source === 'SUPPLIER'
            ? await this.insert(effectiveInput, input.lotNo as string, iqcRequestNo, registerActor)
            : await this.insertInboundMes(effectiveInput, iqcRequestNo, registerActor);
        return (await this.get(Number(row.lot_id))).detail;
      } catch (error) {
        if (!isDuplicateLotNo(error)) throw error;
        // ⛔ 여기서 두 실패가 갈린다. 스캔값 중복은 사람이 고쳐야 풀리므로 400 이고,
        // 서버 채번 충돌은 사용자가 고칠 수 없으므로 다시 뽑다가 409 다(계약).
        if (source === 'SUPPLIER') throw duplicateLotNo();
        if (attempt >= MES_RETRY) {
          throw new ConflictException('user', 'LOT 번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /**
   * ⛔ 수량은 이 경로로 바꾸지 않는다 — 사유·입하 줄·IQC 의뢰를 함께 고치는 수량 정정(`lot-qty-correct.service.ts`)만
   * 수량을 바꾼다. 계약이 `initialQty` 를 필수로 두어 같은 값은 받는다.
   */
  async update(lotId: number, version: number, input: LotUpdate): Promise<{ detail: LotDetail; versionNo: number }> {
    const current = await this.row(lotId);
    if (!current.initial_qty.equals(input.initialQty)) {
      throw one(field('initialQty', ERROR_CODE.INVALID, current.source_type_code === 'WORK_ORDER'
        ? '생산 LOT 수량은 W/O 진행 상세의 실적 정정에서 고칩니다 — 사유를 적어 실적을 정정하세요.'
        : 'LOT 수량은 정상품 입하 처리(W-01-10)의 LOT 수량 정정으로 고칩니다 — 사유를 적어 수량 정정을 하세요.'));
    }

    const updated = await this.prisma.lot.updateMany({
      where: { lot_id: lotId, version_no: version },
      data: {
        manufactured_at: optionalInstant(input.manufacturedAt),
        expiry_date: optionalDay(input.expiryDate),
        remarks: input.remarks ?? null,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(lotId);
  }

  /**
   * ⭐ 판정은 `:complete` 와 **같은 함수**다(`lot-progress.ts`) — 갈리면 완료 화면과 라벨
   * 화면의 값이 어긋난다(공유계약 L-2). ⚠ 생산 LOT 이 아니어도 계약이 막지 않아 그대로
   * 계산한다 — 배분이 0건이라 `UNDER` 로 나온다.
   */
  private async progress(row: LotRow): Promise<LotProgressView> {
    const sum = await this.prisma.production_result_lot_allocation.aggregate({
      where: { lot_id: row.lot_id, ...LIVE_ALLOCATION },
      _sum: { allocated_qty: true },
    });
    return lotProgress(row.initial_qty, sum._sum.allocated_qty ?? new Prisma.Decimal(0));
  }

  private async insert(
    input: LotCreate,
    lotNo: string,
    iqcRequestNo: string | undefined,
    actor: LotRegisterActor,
  ): Promise<LotRow> {
    return this.prisma.$transaction((tx) =>
      this.registry.createWithin(
        tx,
        {
          ...input,
          lotNo,
          incomingIqc:
            iqcRequestNo === undefined
              ? undefined
              : { requestNo: iqcRequestNo, effectiveDate: input.businessDate, requestedAt: input.occurredAt },
        },
        actor,
      ),
    );
  }

  private async insertInboundMes(
    input: LotCreate,
    iqcRequestNo: string | undefined,
    actor: LotRegisterActor,
  ): Promise<LotRow> {
    return this.prisma.$transaction(async (tx) => {
      const source = await this.inboundMesSource(input.sourceId, tx);
      const current = this.fromInboundSource(input, source);
      const lotNo = await nextInboundMaterialLotNo(tx, {
        plantId: current.plantId,
        itemId: current.itemId,
        receivedQty: current.initialQty,
        supplierId: Number(source.inbound_receipt.supplier_id),
        businessDate: current.businessDate,
      });
      return this.registry.createWithin(
        tx,
        {
          ...current,
          lotNo,
          incomingIqc: source.inspection_required
            ? {
                requestNo: requiredIqcRequestNo(iqcRequestNo),
                effectiveDate: current.businessDate,
                requestedAt: current.occurredAt,
              }
            : undefined,
        },
        actor,
      );
    });
  }

  /** SUPPLIER 경로의 원천 라인 — 없으면 `undefined`. 없는 라인의 400 은 코어의 `attach` 가 낸다. */
  private async inboundLine(sourceId: number): Promise<InboundMesSource | undefined> {
    const row = await this.prisma.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: sourceId },
      include: { inbound_receipt: true },
    });
    return row ?? undefined;
  }

  private async inboundMesSource(
    sourceId: number,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<InboundMesSource> {
    const row = await tx.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: sourceId },
      include: { inbound_receipt: true },
    });
    if (!row) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('sourceId', ERROR_CODE.INVALID, '없는 입하 라인입니다.'),
      ]);
    }
    if (row.supplier_lot_label_attached) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('sourceId', ERROR_CODE.STATE_LOCKED, '공급사 LOT 라벨이 이미 부착된 라인입니다.'),
      ]);
    }
    return row;
  }

  private fromInboundSource(input: LotCreate, source: InboundMesSource): LotCreate {
    const errors: ErrorItem[] = [];
    if (input.itemId !== Number(source.item_id)) {
      errors.push(field('itemId', ERROR_CODE.INVALID, '입하 라인의 품목과 다릅니다.'));
    }
    if (!source.received_qty.equals(input.initialQty)) {
      errors.push(field('initialQty', ERROR_CODE.INVALID, '입하 라인의 수량과 다릅니다.'));
    }
    if (input.uomId !== Number(source.uom_id)) {
      errors.push(field('uomId', ERROR_CODE.INVALID, '입하 라인의 단위와 다릅니다.'));
    }
    if (input.plantId !== Number(source.inbound_receipt.plant_id)) {
      errors.push(field('plantId', ERROR_CODE.INVALID, '입하 라인의 공장과 다릅니다.'));
    }
    if (input.lotTypeCode !== MATERIAL_LOT_TYPE) {
      errors.push(field('lotTypeCode', ERROR_CODE.INVALID, '입하 라인은 자재 LOT 으로만 등록할 수 있습니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const identifiers = (input.externalIdentifiers ?? []).filter(
      (identifier) => identifier.identifierTypeCode !== SUPPLIER_LOT_IDENTIFIER,
    );
    const supplierLotNo = source.supplier_lot_no?.trim();
    if (supplierLotNo) {
      identifiers.push({
        identifierTypeCode: SUPPLIER_LOT_IDENTIFIER,
        externalIdentifier: supplierLotNo,
        partnerId: Number(source.inbound_receipt.supplier_id),
      });
    }
    return { ...input, externalIdentifiers: identifiers };
  }

  private async assertWritable(input: LotCreate): Promise<void> {
    const errors: ErrorItem[] = [];
    if (!(input.initialQty > 0)) {
      errors.push(field('initialQty', ERROR_CODE.RANGE, '초기 수량은 0 보다 커야 합니다.'));
    }
    if (!SOURCE_TYPES.includes(input.sourceTypeCode)) {
      errors.push(
        field('sourceTypeCode', ERROR_CODE.INVALID, `이 경로로 오는 원천은 ${SOURCE_TYPES.join(' · ')} 뿐입니다.`),
      );
    }
    // ⚠ 받아서 «형식만» 본다. 담을 칸이 없어 저장하지 않는다 — 서버가 수신 시각으로
    // 다시 잡지 않는다는 C-8 을 지키려면 값을 지어내지 않는 편이 낫다(되돌림 §Z-4).
    assertDay('businessDate', input.businessDate, errors);
    assertInstant('occurredAt', input.occurredAt, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(this.prisma, [
      { field: 'lotTypeCode', value: input.lotTypeCode, groupCode: 'LOT_TYPE' },
      ...(input.externalIdentifiers ?? []).map((identifier) => ({
        field: 'externalIdentifiers.identifierTypeCode',
        value: identifier.identifierTypeCode,
        groupCode: 'LOT_EXTERNAL_IDENTIFIER_TYPE',
      })),
    ]);
  }

  private async row(lotId: number): Promise<LotRow & { lot_four_m_change: FourMChangeRow | null }> {
    const row = await this.prisma.lot.findUnique({
      where: { lot_id: lotId },
      // ⭐ R-5 — `GET .../holds` 와 같은 정렬(0단계 선례 `lot-hold-query.service.ts:45`).
      include: {
        lot_hold: { orderBy: [{ held_at: 'desc' }, { lot_hold_id: 'desc' }] },
        // 4M 변경품(장부 P-86) — 단건도 싣는다(POP 러닝 체인지·LOT 상태 상세 · omf-all-around#63 2단계).
        lot_four_m_change: { select: { change_type_code: true, remarks: true } },
      },
    });
    if (!row) throw new NotFoundException('없는 LOT 입니다.');
    return row;
  }
}

function requiredIqcRequestNo(value: string | undefined): string {
  if (value === undefined) throw new Error('IQC 의뢰번호 선할당이 없습니다.');
  return value;
}
