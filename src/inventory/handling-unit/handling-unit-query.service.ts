import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  HandlingUnitContentView,
  HandlingUnitView,
  handlingUnitContentView,
  handlingUnitView,
} from './handling-unit-view';

export interface HandlingUnitQuery {
  warehouseId?: unknown;
  locationId?: unknown;
  handlingUnitTypeCode?: string;
  statusCode?: string;
  q?: string;
  page?: unknown;
  size?: unknown;
}

/**
 * 조회 3건(PR ①). 재구성 이력 조회는 `repack-event.service.ts`(PR ②)가 따로 갖고,
 * 등록·구성 치환·포장 확정은 뒤 PR 몫이다(`docs/coverage-100/slices/I-16-a2.md` §11-3).
 */
@Injectable()
export class HandlingUnitQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: HandlingUnitQuery): Promise<PagedResponse<HandlingUnitView>> {
    // `page`·`size` 는 형제 목록과 같이 «자른다»(`pagination.ts`) — 400 은 식별자 축에만.
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const warehouseId = numeric('warehouseId', query.warehouseId);
    const locationId = numeric('locationId', query.locationId);

    // ⛔ 값 목록 검증을 «안» 건다 — 없는 코드로 물으면 빈 목록이 정상이다(400 아님).
    //    저장소에 이미 세 번째 status_code 값('ACTIVE')이 굴러다닌다(통보 164 ⓐ · S-11).
    const where: Prisma.handling_unitWhereInput = {
      ...filter('warehouse_id', warehouseId),
      ...filter('location_id', locationId),
      ...(query.handlingUnitTypeCode === undefined
        ? {}
        : { handling_unit_type_code: query.handlingUnitTypeCode }),
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(query.q === undefined ? {} : { handling_unit_no: { contains: query.q } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.handling_unit.findMany({
        where,
        // 계약 침묵 — 등록 역순(스캔 화면이 방금 만든 것을 위에서 찾는다 · §6-1).
        orderBy: { handling_unit_id: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.handling_unit.count({ where }),
    ]);
    return pagedResponse(rows.map(handlingUnitView), total, page);
  }

  /** 계약 선언 — 없으면 404 다. */
  async get(handlingUnitId: number): Promise<{
    handlingUnit: HandlingUnitView;
    contents: HandlingUnitContentView[];
    versionNo: number;
  }> {
    const row = await this.prisma.handling_unit.findUnique({
      where: { handling_unit_id: handlingUnitId },
    });
    if (!row) throw new NotFoundException('없는 취급 단위입니다.');
    return {
      handlingUnit: handlingUnitView(row),
      contents: await this.contentsOf(handlingUnitId),
      versionNo: row.version_no,
    };
  }

  /** 계약 미선언이나 404 를 낸다(형제 자식 조회 선례 · I-16-a2.md §10-3 ⓐ). */
  async contents(handlingUnitId: number): Promise<HandlingUnitContentView[]> {
    const exists = await this.prisma.handling_unit.findUnique({
      where: { handling_unit_id: handlingUnitId },
      select: { handling_unit_id: true },
    });
    if (!exists) throw new NotFoundException('없는 취급 단위입니다.');
    return this.contentsOf(handlingUnitId);
  }

  private async contentsOf(handlingUnitId: number): Promise<HandlingUnitContentView[]> {
    const rows = await this.prisma.handling_unit_content.findMany({
      where: { handling_unit_id: handlingUnitId },
      orderBy: { handling_unit_content_id: 'asc' },
    });
    return rows.map(handlingUnitContentView);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 그냥 넘기면 Prisma 검증 오류가 500 으로 샌다
 *  (형제 목록 선례 · `stock-transfer-query.service.ts`). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}

function number(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
