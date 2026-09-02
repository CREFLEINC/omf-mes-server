import { Injectable } from '@nestjs/common';

import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ReferenceQuery, filter, referencePage, referenceWhere } from './reference.query';

/**
 * 조회 전용 기준정보 7종. 계약이 이들에 **403 을 선언하지 않았다** — 다른 화면이
 * 선택 목록으로 쓰는 참조 자료라 권한으로 가르지 않는다(요구서 §3 정정 2026-09-01 —
 * 「공통코드에서 오는 선택지는 API 호출이다」).
 *
 * 필드 이름은 계약의 `x-source-column` 을 그대로 따른다 — 지어낸 매핑이 없다.
 */
@Injectable()
export class ReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async uoms(query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'uom_code', name: 'uom_name' });
    const [rows, total] = await Promise.all([
      this.prisma.uom.findMany({ where, orderBy: { uom_code: 'asc' }, skip: page.skip, take: page.take }),
      this.prisma.uom.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        uomId: Number(row.uom_id),
        uomCode: row.uom_code,
        uomName: row.uom_name,
        decimalScale: row.decimal_scale,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }

  async legalEntities(query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(query, {
      code: 'legal_entity_code',
      name: 'legal_entity_name',
    });
    const [rows, total] = await Promise.all([
      this.prisma.legal_entity.findMany({
        where,
        orderBy: { legal_entity_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.legal_entity.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        legalEntityId: Number(row.legal_entity_id),
        legalEntityCode: row.legal_entity_code,
        legalEntityName: row.legal_entity_name,
        countryCode: row.country_code,
        timezoneCode: row.timezone_code,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }

  async businessUnits(
    query: ReferenceQuery & { legalEntityId?: number },
  ): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'business_unit_code', name: 'business_unit_name' },
      filter('legal_entity_id', query.legalEntityId),
    );
    const [rows, total] = await Promise.all([
      this.prisma.business_unit.findMany({
        where,
        orderBy: { business_unit_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.business_unit.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        businessUnitId: Number(row.business_unit_id),
        legalEntityId: Number(row.legal_entity_id),
        businessUnitCode: row.business_unit_code,
        businessUnitName: row.business_unit_name,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }

  async plants(
    query: ReferenceQuery & { legalEntityId?: number; businessUnitId?: number },
  ): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'plant_code', name: 'plant_name' }, {
      ...filter('legal_entity_id', query.legalEntityId),
      ...filter('business_unit_id', query.businessUnitId),
    });
    const [rows, total] = await Promise.all([
      this.prisma.plant.findMany({
        where,
        orderBy: { plant_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.plant.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        plantId: Number(row.plant_id),
        legalEntityId: Number(row.legal_entity_id),
        // 계약이 nullable 로 선언했다 — null 을 그대로 낸다.
        businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
        plantCode: row.plant_code,
        plantName: row.plant_name,
        timezoneCode: row.timezone_code,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }

  async productionLines(
    query: ReferenceQuery & { plantId?: number },
  ): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'line_code', name: 'line_name' },
      filter('plant_id', query.plantId),
    );
    const [rows, total] = await Promise.all([
      this.prisma.production_line.findMany({
        where,
        orderBy: { line_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.production_line.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        productionLineId: Number(row.production_line_id),
        plantId: Number(row.plant_id),
        parentLineId: row.parent_line_id === null ? null : Number(row.parent_line_id),
        lineCode: row.line_code,
        lineName: row.line_name,
        lineTypeCode: row.line_type_code,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }

  async processes(query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'process_code', name: 'process_name' });
    const [rows, total] = await Promise.all([
      this.prisma.process.findMany({
        where,
        orderBy: { process_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.process.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        processId: Number(row.process_id),
        processCode: row.process_code,
        processName: row.process_name,
        processTypeCode: row.process_type_code,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }

  async shifts(query: ReferenceQuery & { plantId?: number }): Promise<PagedResponse<unknown>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'shift_code', name: 'shift_name' },
      filter('plant_id', query.plantId),
    );
    const [rows, total] = await Promise.all([
      this.prisma.shift.findMany({
        where,
        orderBy: { shift_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.shift.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => ({
        shiftId: Number(row.shift_id),
        plantId: Number(row.plant_id),
        shiftCode: row.shift_code,
        shiftName: row.shift_name,
        // 계약이 `time` 을 문자열로 받는다. Prisma 가 Date 로 주므로 HH:MM:SS 만 낸다.
        startTime: row.start_time.toISOString().slice(11, 19),
        endTime: row.end_time.toISOString().slice(11, 19),
        crossesMidnight: row.crosses_midnight,
        isActive: row.is_active,
      })),
      total,
      page,
    );
  }
}
