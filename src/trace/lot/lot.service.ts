import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import {
  ExternalIdentifierInput,
  LotRegisterInput,
  LotRegistryService,
  mesLotNo,
  optionalDay,
  optionalInstant,
} from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertDay,
  assertId,
  assertInstant,
  assertNumberSource,
  bool,
  completedWhere,
  duplicateLotNo,
  expiryWhere,
  isDuplicateLotNo,
  loose,
  optional,
  workOrderWhere,
} from './lot-rules';
import { LotDetail, LotRow, LotView, holdView, identifierView, lotView } from './lot-view';

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

export type { ExternalIdentifierInput };

/** 코어가 받는 칸(`LotRegisterInput`)에 이 경로만 쓰는 넷을 더한 것이다. */
export interface LotCreate extends Omit<LotRegisterInput, 'lotNo'> {
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
  page?: number;
  size?: number;
}

@Injectable()
export class LotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: LotRegistryService,
  ) {}

  async list(query: LotQuery): Promise<PagedResponse<LotView>> {
    const page = pageRequest({ page: loose(query.page), size: loose(query.size) });
    const where: Prisma.lotWhereInput = {
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
                  some: { external_identifier: { contains: query.q, mode: 'insensitive' } },
                },
              },
            ],
          }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        include: { lot_hold: true },
        orderBy: [{ created_at: 'desc' }, { lot_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.lot.count({ where }),
    ]);
    return pagedResponse(rows.map(lotView), total, page);
  }

  async get(lotId: number): Promise<{ detail: LotDetail; versionNo: number }> {
    const row = await this.row(lotId);
    const identifiers = await this.prisma.lot_external_identifier.findMany({
      where: { lot_id: lotId },
      orderBy: { lot_external_identifier_id: 'asc' },
    });
    return {
      detail: {
        lot: lotView(row),
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
  async create(input: LotCreate, appUserId: number): Promise<LotDetail> {
    const source = assertNumberSource(input);
    await this.assertWritable(input);

    for (let attempt = 0; ; attempt += 1) {
      const lotNo = source === 'SUPPLIER' ? (input.lotNo as string) : await this.nextMesLotNo(input);
      try {
        const row = await this.insert(input, lotNo, appUserId);
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
   * ⛔ **이미 재고가 움직인 LOT 은 수량을 바꿀 수 없다**(계약). 원장에 그 LOT 의 라인이
   * 있으면 400 이다 — 잔액과 초기 수량이 어긋나면 어느 쪽이 참인지 알 수 없어진다.
   */
  async update(
    lotId: number,
    version: number,
    input: LotUpdate,
  ): Promise<{ detail: LotDetail; versionNo: number }> {
    const current = await this.row(lotId);
    if (Number(current.initial_qty) !== input.initialQty && (await this.moved(lotId))) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'initialQty',
          code: ERROR_CODE.STATE_LOCKED,
          message: '이미 재고가 움직인 LOT 은 수량을 바꿀 수 없습니다.',
        },
      ]);
    }

    const updated = await this.prisma.lot.updateMany({
      where: { lot_id: lotId, version_no: version },
      data: {
        initial_qty: input.initialQty,
        manufactured_at: optionalInstant(input.manufacturedAt),
        expiry_date: optionalDay(input.expiryDate),
        remarks: input.remarks ?? null,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(lotId);
  }

  /** 원장이 그 LOT 을 건드린 적이 있는가 — A1 이 세운 표를 되읽는 자리다. */
  private async moved(lotId: number): Promise<boolean> {
    const line = await this.prisma.inventory_transaction_line.findFirst({
      where: { lot_id: lotId },
      select: { inventory_transaction_line_id: true },
    });
    return line !== null;
  }

  private async insert(input: LotCreate, lotNo: string, appUserId: number): Promise<LotRow> {
    return this.prisma.$transaction((tx) =>
      this.registry.createWithin(tx, { ...input, lotNo }, appUserId),
    );
  }

  /**
   * ⚠ 순번은 «연속을 보장하지 않는다» — `count` 로 뽑으므로 같은 순간 두 건이면 같은
   * 값을 얻는다. 뒤의 난수 13자리가 실제 충돌을 막고, 충돌해도 재시도가 받는다. 사람이
   * 「몇 번째쯤인가」를 읽는 용도이지 빠짐없는 일련번호가 아니다.
   */
  private async nextMesLotNo(input: LotCreate): Promise<string> {
    const day = input.businessDate.replace(/-/g, '');
    const used = await this.prisma.lot.count({
      where: { plant_id: input.plantId, lot_no: { startsWith: `M${pad(input.plantId)}${day}` } },
    });
    return mesLotNo(input.plantId, input.businessDate, used + 1);
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

  private async row(lotId: number): Promise<LotRow> {
    const row = await this.prisma.lot.findUnique({
      where: { lot_id: lotId },
      include: { lot_hold: true },
    });
    if (!row) throw new NotFoundException('없는 LOT 입니다.');
    return row;
  }
}

function pad(plantId: number): string {
  return String(plantId).padStart(6, '0').slice(-6);
}
