import { Injectable } from '@nestjs/common';

import { ErrorCode, ErrorItem, fieldError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BuItemMapRowDto,
  ExternalCodeRowDto,
  UomConversionRowDto,
} from './item-child.dto';

/**
 * 부속 3종은 **통째로 갈아끼운다**. 그래서 검증이 두 겹이다.
 *
 *  1. 행 하나가 규칙에 맞는가 — DB CHECK 제약과 같은 것을 서버가 먼저 본다
 *  2. **보낸 목록 안에 중복이 없는가** — 유일 제약은 저장할 때야 터지고, 그때는 어느
 *     행이 문제인지 알려주기 어렵다. 지우고 넣는 트랜잭션 한복판이라 더 그렇다.
 *
 * 두 번째가 단건 쓰기에는 없던 것이다.
 */
@Injectable()
export class ItemChildValidator {
  constructor(private readonly prisma: PrismaService) {}

  async validateUomConversions(rows: UomConversionRowDto[]): Promise<ErrorItem[]> {
    const errors: ErrorItem[] = [];

    rows.forEach((row, index) => {
      if (row.fromUomId === row.toUomId) {
        errors.push(rowError(index, 'toUomId', '출발 단위와 도착 단위가 같을 수 없습니다.'));
      }
      errors.push(...checkDates(index, row.effectiveFrom, row.effectiveTo));
    });

    // uq_item_uom_conversion (item_id, from_uom_id, to_uom_id, effective_from)
    errors.push(
      ...duplicates(rows, (row) => `${row.fromUomId}|${row.toUomId}|${row.effectiveFrom}`, 'fromUomId'),
    );

    const uomIds = [...new Set(rows.flatMap((row) => [row.fromUomId, row.toUomId]))];
    errors.push(...(await this.missing('uom', uomIds, 'fromUomId', '없는 단위입니다.')));

    return errors;
  }

  async validateExternalCodes(rows: ExternalCodeRowDto[]): Promise<ErrorItem[]> {
    const errors: ErrorItem[] = [];

    // uq_item_external_code 는 COALESCE(partner_id, 0) 으로 유일 판정한다 —
    // 거래처를 비우면 「(전체)」 한 자리로 접힌다(공유계약 A-7). 여기서도 같게 접는다.
    errors.push(
      ...duplicates(
        rows,
        (row) => `${row.externalSystemCode}|${row.partnerId ?? 0}|${row.externalItemCode}`,
        'externalItemCode',
      ),
    );

    const partnerIds = [
      ...new Set(rows.map((row) => row.partnerId).filter((id): id is number => !!id)),
    ];
    errors.push(...(await this.missing('partner', partnerIds, 'partnerId', '없는 거래처입니다.')));

    return errors;
  }

  async validateBuItemMaps(rows: BuItemMapRowDto[]): Promise<ErrorItem[]> {
    const errors: ErrorItem[] = [];

    rows.forEach((row, index) => {
      if (row.fromBusinessUnitId === row.toBusinessUnitId) {
        errors.push(
          rowError(index, 'toBusinessUnitId', '출발 사업부와 도착 사업부가 같을 수 없습니다.'),
        );
      }
      errors.push(...checkDates(index, row.effectiveFrom, row.effectiveTo));
    });

    // uq_item_bu_item_map (from_business_unit_id, from_item_id, to_business_unit_id, effective_from)
    // from_item_id 는 경로로 고정되므로 키에 넣지 않는다.
    errors.push(
      ...duplicates(
        rows,
        (row) => `${row.fromBusinessUnitId}|${row.toBusinessUnitId}|${row.effectiveFrom}`,
        'toBusinessUnitId',
      ),
    );

    const businessUnitIds = [
      ...new Set(rows.flatMap((row) => [row.fromBusinessUnitId, row.toBusinessUnitId])),
    ];
    const itemIds = [...new Set(rows.map((row) => row.toItemId))];

    const [units, items] = await Promise.all([
      this.missing('business_unit', businessUnitIds, 'fromBusinessUnitId', '없는 사업부입니다.'),
      this.missing('item', itemIds, 'toItemId', '없는 품목입니다.'),
    ]);

    return [...errors, ...units, ...items];
  }

  /** 참조가 실재하는가. 한 번에 모아 조회한다 — 행마다 왕복하면 500행에 500번이다. */
  private async missing(
    model: 'uom' | 'partner' | 'business_unit' | 'item',
    ids: number[],
    field: string,
    message: string,
  ): Promise<ErrorItem[]> {
    if (ids.length === 0) return [];

    const found = await this.count(model, ids);

    return found === ids.length ? [] : [fieldError(field, ErrorCode.RANGE, message)];
  }

  private count(
    model: 'uom' | 'partner' | 'business_unit' | 'item',
    ids: number[],
  ): Promise<number> {
    const values = ids.map(BigInt);

    switch (model) {
      case 'uom':
        return this.prisma.uom.count({ where: { uom_id: { in: values } } });
      case 'partner':
        return this.prisma.partner.count({ where: { partner_id: { in: values } } });
      case 'business_unit':
        return this.prisma.business_unit.count({ where: { business_unit_id: { in: values } } });
      case 'item':
        return this.prisma.item.count({ where: { item_id: { in: values } } });
    }
  }
}

/** 몇 번째 행이 문제인지 알려준다 — 목록을 통째로 보내므로 필드 이름만으로는 못 찾는다. */
function rowError(index: number, field: string, message: string): ErrorItem {
  return fieldError(`[${index}].${field}`, ErrorCode.RANGE, message);
}

/** `2026-08-07` 형태라 문자열 비교로 충분하다 — 자릿수가 고정이다. */
function checkDates(index: number, from: string, to: string | null | undefined): ErrorItem[] {
  if (!to) return [];

  return to >= from
    ? []
    : [rowError(index, 'effectiveTo', '종료일이 시작일보다 앞설 수 없습니다.')];
}

/**
 * 보낸 목록 안의 중복. DB 유일 제약에 맡기면 트랜잭션 한복판에서 터지고, 어느 행이
 * 문제인지 알려주기 어렵다.
 */
function duplicates<T>(rows: T[], key: (row: T) => string, field: string): ErrorItem[] {
  const seen = new Map<string, number>();
  const errors: ErrorItem[] = [];

  rows.forEach((row, index) => {
    const value = key(row);
    const first = seen.get(value);

    if (first === undefined) {
      seen.set(value, index);
    } else {
      errors.push(rowError(index, field, `${first} 번째 행과 중복됩니다.`));
    }
  });

  return errors;
}
