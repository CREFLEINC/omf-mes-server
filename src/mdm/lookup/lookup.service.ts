import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PagedQueryDto } from '../paged-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  toBusinessUnit,
  toEquipment,
  toLegalEntity,
  toPartner,
  toPlant,
  toProcess,
  toProductionLine,
  toUom,
} from './lookup.mapper';
import {
  BusinessUnitQueryDto,
  EquipmentQueryDto,
  LookupQueryDto,
  PlantQueryDto,
  ProductionLineQueryDto,
} from './lookup.query.dto';

type Page<T> = { items: T[]; page: components['schemas']['PageMeta'] };

/**
 * 조회 전용 8종. 화면이 드롭다운을 채우거나 필터를 거는 데 쓴다 — 쓰기는 계약에 없다.
 *
 * 마스터마다 검색 컬럼과 정렬 키가 달라 한 함수로 묶지 않는다. 대신 **정렬 키는 전부
 * 유일키**로 맞춘다 — 불안정하면 페이지를 넘길 때 같은 행이 두 번 나오거나 빠진다.
 */
@Injectable()
export class LookupService {
  constructor(private readonly prisma: PrismaService) {}

  async findUoms(query: LookupQueryDto): Promise<Page<components['schemas']['Uom']>> {
    const where: Prisma.uomWhereInput = active(query);
    if (query.q) where.OR = search(query.q, ['uom_code', 'uom_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.uom.findMany({ where, orderBy: { uom_code: 'asc' }, ...window(query) }),
      this.prisma.uom.count({ where }),
    ]);

    return { items: rows.map(toUom), page: meta(query, total) };
  }

  async findPartners(query: LookupQueryDto): Promise<Page<components['schemas']['Partner']>> {
    const where: Prisma.partnerWhereInput = active(query);
    if (query.q) where.OR = search(query.q, ['partner_code', 'partner_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.partner.findMany({ where, orderBy: { partner_code: 'asc' }, ...window(query) }),
      this.prisma.partner.count({ where }),
    ]);

    return { items: rows.map(toPartner), page: meta(query, total) };
  }

  async findLegalEntities(
    query: LookupQueryDto,
  ): Promise<Page<components['schemas']['LegalEntity']>> {
    const where: Prisma.legal_entityWhereInput = active(query);
    if (query.q) where.OR = search(query.q, ['legal_entity_code', 'legal_entity_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.legal_entity.findMany({
        where,
        orderBy: { legal_entity_code: 'asc' },
        ...window(query),
      }),
      this.prisma.legal_entity.count({ where }),
    ]);

    return { items: rows.map(toLegalEntity), page: meta(query, total) };
  }

  async findBusinessUnits(
    query: BusinessUnitQueryDto,
  ): Promise<Page<components['schemas']['BusinessUnit']>> {
    const where: Prisma.business_unitWhereInput = active(query);
    if (query.legalEntityId) where.legal_entity_id = BigInt(query.legalEntityId);
    if (query.q) where.OR = search(query.q, ['business_unit_code', 'business_unit_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.business_unit.findMany({
        where,
        // uq_business_unit — 코드만으로는 법인이 다르면 겹친다.
        orderBy: [{ legal_entity_id: 'asc' }, { business_unit_code: 'asc' }],
        ...window(query),
      }),
      this.prisma.business_unit.count({ where }),
    ]);

    return { items: rows.map(toBusinessUnit), page: meta(query, total) };
  }

  async findPlants(query: PlantQueryDto): Promise<Page<components['schemas']['Plant']>> {
    const where: Prisma.plantWhereInput = active(query);
    if (query.legalEntityId) where.legal_entity_id = BigInt(query.legalEntityId);
    if (query.businessUnitId) where.business_unit_id = BigInt(query.businessUnitId);
    if (query.q) where.OR = search(query.q, ['plant_code', 'plant_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.plant.findMany({
        where,
        orderBy: [{ legal_entity_id: 'asc' }, { plant_code: 'asc' }],
        ...window(query),
      }),
      this.prisma.plant.count({ where }),
    ]);

    return { items: rows.map(toPlant), page: meta(query, total) };
  }

  async findProductionLines(
    query: ProductionLineQueryDto,
  ): Promise<Page<components['schemas']['ProductionLine']>> {
    const where: Prisma.production_lineWhereInput = active(query);
    if (query.plantId) where.plant_id = BigInt(query.plantId);
    if (query.q) where.OR = search(query.q, ['line_code', 'line_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.production_line.findMany({
        where,
        orderBy: [{ plant_id: 'asc' }, { line_code: 'asc' }],
        ...window(query),
      }),
      this.prisma.production_line.count({ where }),
    ]);

    return { items: rows.map(toProductionLine), page: meta(query, total) };
  }

  async findProcesses(query: LookupQueryDto): Promise<Page<components['schemas']['Process']>> {
    const where: Prisma.processWhereInput = active(query);
    if (query.q) where.OR = search(query.q, ['process_code', 'process_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.process.findMany({ where, orderBy: { process_code: 'asc' }, ...window(query) }),
      this.prisma.process.count({ where }),
    ]);

    return { items: rows.map(toProcess), page: meta(query, total) };
  }

  async findEquipments(query: EquipmentQueryDto): Promise<Page<components['schemas']['Equipment']>> {
    const where: Prisma.equipmentWhereInput = active(query);
    if (query.plantId) where.plant_id = BigInt(query.plantId);
    if (query.processId) where.process_id = BigInt(query.processId);
    if (query.q) where.OR = search(query.q, ['equipment_code', 'equipment_name']);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.equipment.findMany({
        where,
        orderBy: [{ plant_id: 'asc' }, { equipment_code: 'asc' }],
        ...window(query),
      }),
      this.prisma.equipment.count({ where }),
    ]);

    return { items: rows.map(toEquipment), page: meta(query, total) };
  }
}

/** 기본은 사용 중인 것만. 켜면 중지된 것도 함께 내린다. */
function active(query: PagedQueryDto): { is_active?: boolean } {
  return query.includeInactive ? {} : { is_active: true };
}

/** 코드·명칭 두 칸을 대소문자 구분 없이 본다. */
function search(q: string, columns: [string, string]) {
  return columns.map((column) => ({ [column]: { contains: q, mode: 'insensitive' as const } }));
}

function window(query: PagedQueryDto): { skip: number; take: number } {
  return { skip: query.skip, take: query.size };
}

function meta(query: PagedQueryDto, total: number): components['schemas']['PageMeta'] {
  return { page: query.page, size: query.size, total };
}
