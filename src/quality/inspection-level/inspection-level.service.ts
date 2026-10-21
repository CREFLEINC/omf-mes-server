import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionLevelCode } from './inspection-level-rules';

/** 계약 `ItemInspectionLevel`(장부 P-87). 품목 코드·이름은 화면이 따로 풀지 않게 함께 싣는다. */
export interface ItemInspectionLevelView {
  itemInspectionLevelId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  inspectionLevelCode: string;
  autoSwitchEnabled: boolean;
  consecutiveAcceptCount: number;
  updatedAt: string;
  versionNo: number;
}

/** 계약 `ItemInspectionLevelHistory`. */
export interface ItemInspectionLevelHistoryView {
  itemInspectionLevelHistoryId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  fromLevelCode: string | null;
  toLevelCode: string;
  changeTypeCode: string;
  consecutiveAcceptCount: number | null;
  inspectionRequestId: number | null;
  inspectionRequestNo: string | null;
  reason: string | null;
  changedAt: string;
  changedByName: string | null;
}

export interface ItemInspectionLevelCreate {
  itemId: number;
  inspectionLevelCode: InspectionLevelCode;
  autoSwitchEnabled?: boolean;
  /** 선택 — 비우면 이력의 사유도 비워 둔다. */
  reason?: string;
}

/** 생략 = 유지. 수준이 바뀌면 사유 필수. */
export interface ItemInspectionLevelUpdate {
  inspectionLevelCode?: InspectionLevelCode;
  autoSwitchEnabled?: boolean;
  reason?: string;
}

export interface ItemInspectionLevelQuery {
  itemId?: number;
  inspectionLevelCode?: string;
  q?: string;
  page?: number;
  size?: number;
}

export interface ItemInspectionLevelHistoryQuery {
  itemId?: number;
  changeTypeCode?: string;
  from?: string;
  to?: string;
  page?: number;
  size?: number;
}

const MANUAL = 'MANUAL';
const ITEM = { select: { item_code: true, item_name: true } } as const;
const HISTORY_INCLUDE = {
  item: ITEM,
  inspection_request: { select: { inspection_request_no: true } },
  app_user: { select: { user_name: true } },
  worker: { select: { worker_name: true } },
} as const;

type LevelRow = Prisma.item_inspection_levelGetPayload<{ include: { item: typeof ITEM } }>;
type HistoryRow = Prisma.item_inspection_level_historyGetPayload<{ include: typeof HISTORY_INCLUDE }>;

/** 품목별 검사 수준 지정·수동 변경·조회와 전환 이력 조회(검사 수준 관리 화면 W-03-12). 자동 전환은 `inspection-level-switch.ts`. */
@Injectable()
export class InspectionLevelService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ItemInspectionLevelQuery): Promise<PagedResponse<ItemInspectionLevelView>> {
    const page = pageRequest(query);
    const q = query.q?.trim();
    const where: Prisma.item_inspection_levelWhereInput = {
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(query.inspectionLevelCode === undefined ? {} : { inspection_level_code: query.inspectionLevelCode }),
      ...(q === undefined || q === ''
        ? {}
        : {
            item: {
              OR: [
                { item_code: { contains: q, mode: Prisma.QueryMode.insensitive } },
                { item_name: { contains: q, mode: Prisma.QueryMode.insensitive } },
              ],
            },
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.item_inspection_level.findMany({
        where,
        include: { item: ITEM },
        orderBy: [{ item: { item_code: 'asc' } }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.item_inspection_level.count({ where }),
    ]);
    return pagedResponse(rows.map(levelView), total, page);
  }

  async get(id: number): Promise<{ itemInspectionLevel: ItemInspectionLevelView; versionNo: number }> {
    const row = await this.prisma.item_inspection_level.findUnique({
      where: { item_inspection_level_id: id },
      include: { item: ITEM },
    });
    if (!row) throw new NotFoundException('없는 검사 수준입니다.');
    return { itemInspectionLevel: levelView(row), versionNo: row.version_no };
  }

  async create(input: ItemInspectionLevelCreate, appUserId: number | undefined): Promise<ItemInspectionLevelView> {
    const reason = input.reason?.trim() || null;
    const item = await this.prisma.item.findUnique({ where: { item_id: input.itemId }, select: { item_id: true } });
    if (!item) throw one(field('itemId', ERROR_CODE.INVALID, '없는 품목입니다.'));
    const id = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.item_inspection_level.create({
          data: {
            item_id: input.itemId,
            inspection_level_code: input.inspectionLevelCode,
            auto_switch_enabled: input.autoSwitchEnabled ?? true,
            created_by: appUserId ?? null,
            updated_by: appUserId ?? null,
          },
          select: { item_inspection_level_id: true },
        });
        await tx.item_inspection_level_history.create({
          data: {
            item_id: input.itemId,
            from_level_code: null,
            to_level_code: input.inspectionLevelCode,
            change_type_code: MANUAL,
            reason,
            changed_by: appUserId ?? null,
          },
        });
        return created.item_inspection_level_id;
      })
      .catch(rethrowDuplicate);
    return (await this.get(Number(id))).itemInspectionLevel;
  }

  async update(
    id: number,
    version: number,
    input: ItemInspectionLevelUpdate,
    appUserId: number | undefined,
  ): Promise<{ itemInspectionLevel: ItemInspectionLevelView; versionNo: number }> {
    const current = await this.prisma.item_inspection_level.findUnique({ where: { item_inspection_level_id: id } });
    if (!current) throw new NotFoundException('없는 검사 수준입니다.');
    const levelChanged =
      input.inspectionLevelCode !== undefined && input.inspectionLevelCode !== current.inspection_level_code;
    const reason = levelChanged ? requiredReason(input.reason) : undefined;

    await this.prisma.$transaction(async (tx) => {
      // ⛔ version_no 를 조건에 건다 — 자동 전환(IQC 확정)도 이 행의 버전을 올리므로 그 사이의 전환과도 충돌로 갈린다.
      const updated = await tx.item_inspection_level.updateMany({
        where: { item_inspection_level_id: id, version_no: version },
        data: {
          ...(levelChanged ? { inspection_level_code: input.inspectionLevelCode, consecutive_accept_count: 0 } : {}),
          ...(input.autoSwitchEnabled === undefined ? {} : { auto_switch_enabled: input.autoSwitchEnabled }),
          updated_at: new Date(),
          updated_by: appUserId ?? null,
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count);
      if (!levelChanged) return;
      await tx.item_inspection_level_history.create({
        data: {
          item_id: current.item_id,
          from_level_code: current.inspection_level_code,
          to_level_code: input.inspectionLevelCode as string,
          change_type_code: MANUAL,
          reason,
          changed_by: appUserId ?? null,
        },
      });
    });
    return this.get(id);
  }

  async histories(query: ItemInspectionLevelHistoryQuery): Promise<PagedResponse<ItemInspectionLevelHistoryView>> {
    const page = pageRequest(query);
    const where: Prisma.item_inspection_level_historyWhereInput = {
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(query.changeTypeCode === undefined ? {} : { change_type_code: query.changeTypeCode }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            changed_at: {
              ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
              ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
            },
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.item_inspection_level_history.findMany({
        where,
        include: HISTORY_INCLUDE,
        orderBy: [{ changed_at: 'desc' }, { item_inspection_level_history_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.item_inspection_level_history.count({ where }),
    ]);
    return pagedResponse(rows.map(historyView), total, page);
  }
}

function requiredReason(reason: string | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed === '') throw one(field('reason', ERROR_CODE.REQUIRED, '변경 사유를 입력하세요.'));
  return trimmed;
}

function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { ...field('itemId', ERROR_CODE.UNIQUE_VIOLATION, '이미 검사 수준이 지정된 품목입니다.'), uniqueScope: ['itemId'] },
    ]);
  }
  throw error;
}

function levelView(row: LevelRow): ItemInspectionLevelView {
  return {
    itemInspectionLevelId: Number(row.item_inspection_level_id),
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    inspectionLevelCode: row.inspection_level_code,
    autoSwitchEnabled: row.auto_switch_enabled,
    consecutiveAcceptCount: row.consecutive_accept_count,
    updatedAt: row.updated_at.toISOString(),
    versionNo: row.version_no,
  };
}

function historyView(row: HistoryRow): ItemInspectionLevelHistoryView {
  return {
    itemInspectionLevelHistoryId: Number(row.item_inspection_level_history_id),
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    fromLevelCode: row.from_level_code,
    toLevelCode: row.to_level_code,
    changeTypeCode: row.change_type_code,
    consecutiveAcceptCount: row.consecutive_accept_count,
    inspectionRequestId: row.inspection_request_id === null ? null : Number(row.inspection_request_id),
    inspectionRequestNo: row.inspection_request?.inspection_request_no ?? null,
    reason: row.reason,
    changedAt: row.changed_at.toISOString(),
    changedByName: row.app_user?.user_name ?? row.worker?.worker_name ?? null,
  };
}
