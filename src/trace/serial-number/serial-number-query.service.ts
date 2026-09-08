import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { serialNumberTimeBoundary } from './serial-number-time-boundary';
import { SerialNumberView, serialNumberView } from './serial-number-view';

export interface SerialNumberListQuery {
  lotId?: number;
  itemId?: number;
  statusCode?: string;
  producedFrom?: string;
  producedTo?: string;
  q?: string;
  page?: number;
  size?: number;
}

export function serialNumberWhere(query: SerialNumberListQuery): Prisma.serial_numberWhereInput {
  const producedAt = {
    ...(query.producedFrom === undefined
      ? {}
      : { gte: serialNumberTimeBoundary(query.producedFrom) }),
    ...(query.producedTo === undefined ? {} : { lt: serialNumberTimeBoundary(query.producedTo) }),
  };
  return {
    ...(query.lotId === undefined ? {} : { lot_id: query.lotId }),
    ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
    ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    ...(query.q === undefined ? {} : { serial_no: { contains: query.q, mode: 'insensitive' } }),
    ...(Object.keys(producedAt).length === 0 ? {} : { produced_at: producedAt }),
  };
}

@Injectable()
export class SerialNumberQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SerialNumberListQuery): Promise<PagedResponse<SerialNumberView>> {
    const page = pageRequest(query);
    const where = serialNumberWhere(query);
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.serial_number.findMany({
          where,
          orderBy: { serial_number_id: 'asc' },
          skip: page.skip,
          take: page.take,
        }),
        this.prisma.serial_number.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pagedResponse(rows.map(serialNumberView), total, page);
  }
}
