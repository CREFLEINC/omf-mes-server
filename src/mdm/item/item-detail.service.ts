import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { toDateString } from '../column';

/**
 * 품목 「부속 정보」 세 탭 — 사업부매핑 · 외부코드 · 단위환산.
 *
 * 셋 다 같은 성질이다. 개별 부여·회수가 아니라 **최종 상태를 통째로** 받고, 자식 표에
 * `is_active`·`updated_at`·`version_no` 가 없다(계약이 「부여·회수 형태」로 적었다).
 *
 * ⛔ 그래서 잠금 축이 «품목»의 `version_no` 다. 계약이 「토큰은 같은 경로의 조회가
 * 내려주는 ETag 다」로 적었고, 그 조회가 낼 수 있는 값은 이것뿐이다. 작업자 자격(#115)·
 * 창고 배치도(#118)와 같은 판단이다.
 *
 * 세 탭이 축을 공유하므로 한 탭을 저장하면 다른 탭의 ETag 도 낡는다. 같은 품목의 부속을
 * 동시에 고치는 두 저장이 서로를 막는 것이라 과하지 않다 — 계약이 `B-6` 로 「통째로
 * 교체하는 저장이라 보호가 없으면 남이 방금 넣은 줄이 조용히 사라진다」고 적은 그 위험이다.
 */

interface BuItemMapView {
  itemBuItemMapId: number;
  fromBusinessUnitId: number;
  fromItemId: number;
  toBusinessUnitId: number;
  toItemId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface ExternalCodeView {
  itemExternalCodeId: number;
  itemId: number;
  externalSystemCode: string;
  partnerId: number | null;
  externalItemCode: string;
}

interface UomConversionView {
  itemUomConversionId: number;
  itemId: number;
  fromUomId: number;
  toUomId: number;
  conversionRate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface BuItemMapInput {
  fromBusinessUnitId: number;
  toBusinessUnitId: number;
  toItemId: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface ExternalCodeInput {
  externalSystemCode: string;
  partnerId?: number | null;
  externalItemCode: string;
}

export interface UomConversionInput {
  fromUomId: number;
  toUomId: number;
  conversionRate: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface Replaced<T> {
  items: T[];
  versionNo: number;
}

@Injectable()
export class ItemDetailService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 사업부 매핑 ──────────────────────────────────────────────────────────

  async listBuItemMaps(itemId: number): Promise<Replaced<BuItemMapView>> {
    const versionNo = await this.itemVersion(itemId);
    return { items: await this.readBuItemMaps(itemId), versionNo };
  }

  /**
   * `fromItemId` 는 경로의 `itemId` 로 «고정»한다 — 본문에 자리가 없다(계약).
   * 사업부 간 이동입고는 이 매핑이 없으면 차단된다(1-3 SCN-28).
   */
  async replaceBuItemMaps(
    itemId: number,
    version: number,
    maps: BuItemMapInput[],
    appUserId?: number,
  ): Promise<Replaced<BuItemMapView>> {
    assertBuItemMaps(maps);
    await this.withBumpedItem(itemId, version, async (tx) => {
      await tx.item_bu_item_map.deleteMany({ where: { from_item_id: itemId } });
      if (maps.length === 0) return;
      await tx.item_bu_item_map.createMany({
        data: maps.map((map) => ({
          from_business_unit_id: map.fromBusinessUnitId,
          from_item_id: itemId,
          to_business_unit_id: map.toBusinessUnitId,
          to_item_id: map.toItemId,
          effective_from: new Date(map.effectiveFrom),
          effective_to: map.effectiveTo == null ? null : new Date(map.effectiveTo),
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });
    return this.listBuItemMaps(itemId);
  }

  // ── 외부 코드 ───────────────────────────────────────────────────────────

  async listExternalCodes(itemId: number): Promise<Replaced<ExternalCodeView>> {
    const versionNo = await this.itemVersion(itemId);
    return { items: await this.readExternalCodes(itemId), versionNo };
  }

  async replaceExternalCodes(
    itemId: number,
    version: number,
    externalCodes: ExternalCodeInput[],
    appUserId?: number,
  ): Promise<Replaced<ExternalCodeView>> {
    assertExternalCodes(externalCodes);
    await this.withBumpedItem(itemId, version, async (tx) => {
      await tx.item_external_code.deleteMany({ where: { item_id: itemId } });
      if (externalCodes.length === 0) return;
      await tx.item_external_code.createMany({
        data: externalCodes.map((code) => ({
          item_id: itemId,
          external_system_code: code.externalSystemCode,
          partner_id: code.partnerId ?? null,
          external_item_code: code.externalItemCode,
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });
    return this.listExternalCodes(itemId);
  }

  // ── 단위 환산 ───────────────────────────────────────────────────────────

  async listUomConversions(itemId: number): Promise<Replaced<UomConversionView>> {
    const versionNo = await this.itemVersion(itemId);
    return { items: await this.readUomConversions(itemId), versionNo };
  }

  async replaceUomConversions(
    itemId: number,
    version: number,
    conversions: UomConversionInput[],
    appUserId?: number,
  ): Promise<Replaced<UomConversionView>> {
    assertUomConversions(conversions);
    await this.withBumpedItem(itemId, version, async (tx) => {
      await tx.item_uom_conversion.deleteMany({ where: { item_id: itemId } });
      if (conversions.length === 0) return;
      await tx.item_uom_conversion.createMany({
        data: conversions.map((conversion) => ({
          item_id: itemId,
          from_uom_id: conversion.fromUomId,
          to_uom_id: conversion.toUomId,
          conversion_rate: conversion.conversionRate,
          effective_from: new Date(conversion.effectiveFrom),
          effective_to: conversion.effectiveTo == null ? null : new Date(conversion.effectiveTo),
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });
    return this.listUomConversions(itemId);
  }

  // ── 공통 ────────────────────────────────────────────────────────────────

  /** 품목 버전을 조건부로 올리고, 그 트랜잭션 안에서 자식을 통째로 갈아 끼운다. */
  private async withBumpedItem(
    itemId: number,
    version: number,
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.item.updateMany({
        where: { item_id: itemId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.item.findUnique({
          where: { item_id: itemId },
          select: { item_id: true },
        });
        if (!exists) throw new NotFoundException('없는 품목입니다.');
        assertUpdated(0);
      }
      await work(tx);
    });
  }

  private async itemVersion(itemId: number): Promise<number> {
    const row = await this.prisma.item.findUnique({
      where: { item_id: itemId },
      select: { version_no: true },
    });
    if (!row) throw new NotFoundException('없는 품목입니다.');
    return row.version_no;
  }

  private async readBuItemMaps(itemId: number): Promise<BuItemMapView[]> {
    const rows = await this.prisma.item_bu_item_map.findMany({
      where: { from_item_id: itemId },
      orderBy: [{ to_business_unit_id: 'asc' }, { effective_from: 'asc' }],
    });
    return rows.map((row) => ({
      itemBuItemMapId: Number(row.item_bu_item_map_id),
      fromBusinessUnitId: Number(row.from_business_unit_id),
      fromItemId: Number(row.from_item_id),
      toBusinessUnitId: Number(row.to_business_unit_id),
      toItemId: Number(row.to_item_id),
      effectiveFrom: toDateString(row.effective_from) as string,
      effectiveTo: toDateString(row.effective_to),
    }));
  }

  private async readExternalCodes(itemId: number): Promise<ExternalCodeView[]> {
    const rows = await this.prisma.item_external_code.findMany({
      where: { item_id: itemId },
      orderBy: [{ external_system_code: 'asc' }, { external_item_code: 'asc' }],
    });
    return rows.map((row) => ({
      itemExternalCodeId: Number(row.item_external_code_id),
      itemId: Number(row.item_id),
      externalSystemCode: row.external_system_code,
      partnerId: row.partner_id === null ? null : Number(row.partner_id),
      externalItemCode: row.external_item_code,
    }));
  }

  private async readUomConversions(itemId: number): Promise<UomConversionView[]> {
    const rows = await this.prisma.item_uom_conversion.findMany({
      where: { item_id: itemId },
      orderBy: [{ from_uom_id: 'asc' }, { to_uom_id: 'asc' }, { effective_from: 'asc' }],
    });
    return rows.map((row) => ({
      itemUomConversionId: Number(row.item_uom_conversion_id),
      itemId: Number(row.item_id),
      fromUomId: Number(row.from_uom_id),
      toUomId: Number(row.to_uom_id),
      conversionRate: Number(row.conversion_rate),
      effectiveFrom: toDateString(row.effective_from) as string,
      effectiveTo: toDateString(row.effective_to),
    }));
  }
}

/**
 * DB 제약이 어차피 막지만 «어느 줄»인지 못 짚는다. 통째로 교체하는 본문이라 줄 번호가
 * 없으면 화면이 고칠 자리를 못 찾는다 — 작업자 자격(#115)과 같은 이유다.
 */
function reject(errors: ErrorItem[]): void {
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function assertBuItemMaps(maps: BuItemMapInput[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();
  maps.forEach((map, index) => {
    // ck_item_bu_map_distinct — 같은 사업부끼리는 매핑이 뜻이 없다.
    if (map.fromBusinessUnitId === map.toBusinessUnitId) {
      errors.push(invalid(`maps[${index}].toBusinessUnitId`, '보내는 사업부와 같을 수 없습니다.'));
    }
    if (map.effectiveTo != null && map.effectiveTo < map.effectiveFrom) {
      errors.push(pair(`maps[${index}].effectiveTo`, '종료일은 시작일보다 앞설 수 없습니다.'));
    }
    // uq_item_bu_item_map — from_item_id 는 경로로 고정이라 나머지 셋이 유일 축이다.
    duplicate(
      seen,
      `${map.fromBusinessUnitId} ${map.toBusinessUnitId} ${map.effectiveFrom}`,
      index,
      `maps[${index}].toBusinessUnitId`,
      ['fromBusinessUnitId', 'toBusinessUnitId', 'effectiveFrom'],
      errors,
    );
  });
  reject(errors);
}

function assertExternalCodes(codes: ExternalCodeInput[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();
  codes.forEach((code, index) => {
    // uq_item_external_code 가 COALESCE(partner_id, 0) 으로 접는다 — 비우면 (전체)다(A-7).
    duplicate(
      seen,
      `${code.externalSystemCode} ${code.partnerId ?? 0} ${code.externalItemCode}`,
      index,
      `externalCodes[${index}].externalItemCode`,
      ['externalSystemCode', 'partnerId', 'externalItemCode'],
      errors,
    );
  });
  reject(errors);
}

function assertUomConversions(conversions: UomConversionInput[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();
  conversions.forEach((conversion, index) => {
    // ck_item_uom_distinct — 자기 자신으로의 환산은 뜻이 없다.
    if (conversion.fromUomId === conversion.toUomId) {
      errors.push(invalid(`conversions[${index}].toUomId`, '환산 전 단위와 같을 수 없습니다.'));
    }
    if (conversion.effectiveTo != null && conversion.effectiveTo < conversion.effectiveFrom) {
      errors.push(
        pair(`conversions[${index}].effectiveTo`, '종료일은 시작일보다 앞설 수 없습니다.'),
      );
    }
    duplicate(
      seen,
      `${conversion.fromUomId} ${conversion.toUomId} ${conversion.effectiveFrom}`,
      index,
      `conversions[${index}].toUomId`,
      ['fromUomId', 'toUomId', 'effectiveFrom'],
      errors,
    );
  });
  reject(errors);
}

function duplicate(
  seen: Map<string, number>,
  key: string,
  index: number,
  field: string,
  uniqueScope: string[],
  errors: ErrorItem[],
): void {
  const first = seen.get(key);
  if (first === undefined) {
    seen.set(key, index);
    return;
  }
  errors.push({
    scope: 'field',
    field,
    code: ERROR_CODE.UNIQUE_VIOLATION,
    uniqueScope,
    message: `${first + 1}번째 줄과 같습니다.`,
  });
}

function invalid(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.INVALID, message };
}

function pair(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.PAIR, message };
}
