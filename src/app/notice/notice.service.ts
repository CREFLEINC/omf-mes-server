import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { optionalDate } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NOTICE_STATUSES,
  NoticeStatus,
  assertScope,
  dateOf,
  statusOf,
  statusWhere,
} from './notice-status';

/**
 * 공지 — 화면 `W-CO-04`.
 *
 * ⭐ 이 도메인의 규칙 셋이 서로 물려 있다.
 *   ① 상태는 파생이다(저장하지 않는다 · `notice-status.ts`).
 *   ② 게시하면 본문이 잠긴다 — 확인 이력이 «무엇에 대한 확인»인지 지키기 위해서다.
 *   ③ 확인과 「확인 없이 닫기」를 나눠 남긴다 — 「확인하지 않았다」도 이력이다.
 */

/** 확인 주체. ⚠ 단말 토큰이 아직 없어 지금은 계정 세션이 정본이다(되돌림 §Y-5). */
export interface Actor {
  appUserId: number;
  workerNo?: string;
  workerName?: string;
}

export interface NoticeWrite {
  title: string;
  body: string;
  startDate: string;
  endDate?: string | null;
  acknowledgeRequired?: boolean;
  scopeCode: string;
  targetWorkOrderId?: number | null;
}

export interface NoticeQuery {
  statusCode?: string;
  scopeCode?: string;
  activeOnly?: boolean | string;
  q?: string;
  overlapFrom?: string;
  overlapTo?: string;
  unacknowledgedByMe?: boolean | string;
  page?: number;
  size?: number;
}

/** 계약 `Notice` 와 동형. */
interface NoticeView {
  noticeId: number;
  title: string;
  body: string;
  statusCode: NoticeStatus;
  startDate: string;
  /**
   * ⛔ 셋은 계약이 `string`·`integer` 로 «널을 받지 않게» 선언하고 required 에서는 뺐다.
   * 없을 때는 `null` 이 아니라 **칸을 빼야** 계약을 통과한다.
   */
  endDate?: string;
  publishedAt?: string;
  createdBy?: number;
  acknowledgeRequired: boolean;
  acknowledgedCount: number;
  targetCount: number | null;
  versionNo: number;
  scopeCode: string;
  targetWorkOrderId: number | null;
  targetWorkOrderNo: string | null;
}

interface AcknowledgementView {
  userId: number;
  userName: string;
  acknowledged: boolean;
  /**
   * ⛔ 계약이 `string`(널 불가)으로 선언하고 required 에서 뺐다 — 손댄 적 없는 사람은
   * **칸이 아예 없다**. 그것이 계약이 적은 세 상태 중 「미확인」이다.
   */
  acknowledgedAt?: string;
  workerNo: string | null;
  workerName: string | null;
}

type NoticeRow = Prisma.noticeGetPayload<{ include: { notice_acknowledgement: true } }>;

@Injectable()
export class NoticeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: NoticeQuery, actor: Actor): Promise<PagedResponse<NoticeView>> {
    const page = pageRequest({ page: loose(query.page), size: loose(query.size) });
    const today = todayUtc();
    const status = assertStatus(query.statusCode);

    const where: Prisma.noticeWhereInput = {
      ...(query.scopeCode === undefined ? {} : { scope_code: query.scopeCode }),
      ...(query.q === undefined ? {} : { title: { contains: query.q, mode: 'insensitive' } }),
      // 「게시 기간이 조회 구간과 겹치면 걸린다 — 시작일 기준이 아니다」(계약). 양끝 포함.
      ...(query.overlapTo === undefined
        ? {}
        : { OR: [{ start_date: null }, { start_date: { lte: date('overlapTo', query.overlapTo) } }] }),
      ...(query.overlapFrom === undefined
        ? {}
        : {
            AND: [
              {
                OR: [{ end_date: null }, { end_date: { gte: date('overlapFrom', query.overlapFrom) } }],
              },
            ],
          }),
      ...(status === undefined ? {} : statusWhere(status, today)),
      ...(bool(query.activeOnly) === true ? statusWhere('PUBLISHED', today) : {}),
      // 「아직 확인하지도 닫지도 않은 게시 중 공지」 — 행이 아예 없는 것이 「미확인」이다.
      ...(bool(query.unacknowledgedByMe) === true
        ? {
            ...statusWhere('PUBLISHED', today),
            notice_acknowledgement: { none: { app_user_id: actor.appUserId } },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notice.findMany({
        where,
        include: { notice_acknowledgement: true },
        orderBy: [{ start_date: 'desc' }, { notice_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.notice.count({ where }),
    ]);
    return pagedResponse(await this.views(rows), total, page);
  }

  async get(noticeId: number): Promise<{ notice: NoticeView; versionNo: number }> {
    const row = await this.row(noticeId);
    const [notice] = await this.views([row]);
    return { notice, versionNo: row.version_no };
  }

  async create(input: NoticeWrite, actor: Actor): Promise<NoticeView> {
    assertScope(input.scopeCode, input.targetWorkOrderId);
    const row = await this.prisma.notice.create({
      data: {
        notice_no: await this.nextNoticeNo(),
        title: input.title,
        content: input.body,
        start_date: date('startDate', input.startDate),
        scope_code: input.scopeCode,
        acknowledge_required: input.acknowledgeRequired ?? false,
        created_by: BigInt(actor.appUserId),
        ...optionalDate('end_date', input.endDate),
        ...(input.targetWorkOrderId == null
          ? {}
          : { target_work_order_id: input.targetWorkOrderId }),
      },
      include: { notice_acknowledgement: true },
    });
    const [notice] = await this.views([row]);
    return notice;
  }

  /**
   * ⛔ **게시 전에만 고칠 수 있다.** 게시 후 본문을 고치면 이미 확인한 사람이 «다른 것»을
   * 본 셈이 되고, 확인 이력이 무엇에 대한 확인인지 알 수 없어진다(계약).
   */
  async update(
    noticeId: number,
    version: number,
    input: NoticeWrite,
    actor: Actor,
  ): Promise<{ notice: NoticeView; versionNo: number }> {
    assertScope(input.scopeCode, input.targetWorkOrderId);
    const current = await this.row(noticeId);
    if (current.published_at !== null) {
      throw new ConflictException('user', '게시한 공지는 본문을 고칠 수 없습니다.');
    }

    const updated = await this.prisma.notice.updateMany({
      where: { notice_id: noticeId, version_no: version },
      data: {
        title: input.title,
        content: input.body,
        start_date: date('startDate', input.startDate),
        scope_code: input.scopeCode,
        acknowledge_required: input.acknowledgeRequired ?? false,
        target_work_order_id: input.targetWorkOrderId ?? null,
        updated_by: BigInt(actor.appUserId),
        ...optionalDate('end_date', input.endDate ?? null),
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(noticeId);
  }

  /** 게시하면 본문이 잠긴다. 두 번 게시할 수는 없다. */
  async publish(
    noticeId: number,
    version: number,
    actor: Actor,
  ): Promise<{ notice: NoticeView; versionNo: number }> {
    const current = await this.row(noticeId);
    if (current.published_at !== null) {
      throw new ConflictException('user', '이미 게시한 공지입니다.');
    }
    const updated = await this.prisma.notice.updateMany({
      where: { notice_id: noticeId, version_no: version },
      data: {
        published_at: new Date(),
        published_by: BigInt(actor.appUserId),
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(noticeId);
  }

  /**
   * ⛔ 종료는 «지우는 것»이 아니라 **종료일을 오늘로 당기는 것**이다 — 확인 이력이 남아야
   * 한다(계약). 그래서 상태가 `CLOSED` 로 파생될 뿐 행은 그대로다.
   */
  async close(
    noticeId: number,
    version: number,
    actor: Actor,
  ): Promise<{ notice: NoticeView; versionNo: number }> {
    const current = await this.row(noticeId);
    if (current.published_at === null) {
      throw new ConflictException('user', '게시하지 않은 공지는 종료할 수 없습니다.');
    }
    const updated = await this.prisma.notice.updateMany({
      where: { notice_id: noticeId, version_no: version },
      data: {
        end_date: todayUtc(),
        closed_at: new Date(),
        closed_by: BigInt(actor.appUserId),
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(noticeId);
  }

  /** 읽은 사람이 스스로 누른다. 같은 사람이 두 번 눌러도 한 줄이다. */
  async acknowledge(noticeId: number, actor: Actor): Promise<void> {
    const notice = await this.row(noticeId);
    if (notice.published_at === null) {
      throw new ConflictException('user', '게시하지 않은 공지는 확인할 수 없습니다.');
    }
    await this.mark(noticeId, actor, true);
  }

  /**
   * 확인하지 «않고» 닫았다를 기록한다. ⛔ 확인 요구가 켜진 공지에는 400 이다 — 그 공지는
   * 닫을 수 없다(계약). 확인과 닫음을 나누는 이유는 「확인하지 않았다」도 이력이기 때문이다.
   */
  async dismiss(noticeId: number, actor: Actor): Promise<void> {
    const notice = await this.row(noticeId);
    if (notice.acknowledge_required) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '확인이 필요한 공지는 닫을 수 없습니다.',
        },
      ]);
    }
    await this.mark(noticeId, actor, false);
  }

  /**
   * 누가 확인했고 누가 아직인가. ⛔ 「행이 없음 = 미확인」이라 **대상 전원**을 세우고 확인
   * 행을 얹는다 — 확인 행만 보면 미확인자가 보이지 않는다.
   */
  async acknowledgements(
    noticeId: number,
    pendingOnly: boolean | undefined,
    query: { page?: number; size?: number },
  ): Promise<PagedResponse<AcknowledgementView>> {
    const notice = await this.row(noticeId);
    const page = pageRequest({ page: loose(query.page), size: loose(query.size) });

    const users = await this.targets(notice);
    const marks = new Map(notice.notice_acknowledgement.map((a) => [String(a.app_user_id), a]));
    const rows: AcknowledgementView[] = users.map((user) => {
      const mark = marks.get(String(user.app_user_id));
      const at = mark?.acknowledged_at ?? null;
      return {
        userId: Number(user.app_user_id),
        userName: user.user_name,
        acknowledged: mark?.acknowledged ?? false,
        ...(at === null ? {} : { acknowledgedAt: at.toISOString() }),
        workerNo: mark?.worker_no ?? null,
        workerName: mark?.worker_name ?? null,
      };
    });

    const kept = pendingOnly === true ? rows.filter((r) => !r.acknowledged) : rows;
    return pagedResponse(kept.slice(page.skip, page.skip + page.take), kept.length, page);
  }

  private async mark(noticeId: number, actor: Actor, acknowledged: boolean): Promise<void> {
    const stamp = {
      acknowledged,
      // ⭐ 시각은 «닫기»로 남은 행에도 찍는다 — 「확인=거짓 + 시각 있음」이 「열람했으나
      // 확인하지 않음」이고, 행이 아예 없는 것이 「미확인」이다(계약). 셋이 다른 상태다.
      acknowledged_at: new Date(),
      ...(actor.workerNo === undefined ? {} : { worker_no: actor.workerNo }),
      ...(actor.workerName === undefined ? {} : { worker_name: actor.workerName }),
    };
    await this.prisma.notice_acknowledgement.upsert({
      where: {
        notice_id_app_user_id: { notice_id: noticeId, app_user_id: actor.appUserId },
      },
      create: { notice_id: noticeId, app_user_id: actor.appUserId, ...stamp },
      update: stamp,
    });
  }

  /**
   * 확인 대상. `COMPANY` 는 쓰는 계정 전부다 — 「새 계정도 자동 포함된다」(계약).
   * ⚠ `WORK_ORDER` 는 **대상을 셀 수 없다** — 작업지시에 사람을 배정하는 자리가 없다.
   * 그래서 분모(`targetCount`)를 비우고, 이 목록도 확인한 사람만 세운다.
   */
  private async targets(notice: NoticeRow): Promise<{ app_user_id: bigint; user_name: string }[]> {
    if (notice.scope_code === 'COMPANY') {
      return this.prisma.app_user.findMany({
        where: { is_active: true },
        select: { app_user_id: true, user_name: true },
        orderBy: { app_user_id: 'asc' },
      });
    }
    const ids = notice.notice_acknowledgement.map((a) => a.app_user_id);
    return this.prisma.app_user.findMany({
      where: { app_user_id: { in: ids } },
      select: { app_user_id: true, user_name: true },
      orderBy: { app_user_id: 'asc' },
    });
  }

  private async views(rows: NoticeRow[]): Promise<NoticeView[]> {
    const today = dateOf(todayUtc());
    const workOrderIds = rows
      .map((row) => row.target_work_order_id)
      .filter((id): id is bigint => id !== null);
    const orders =
      workOrderIds.length === 0
        ? []
        : await this.prisma.work_order.findMany({
            where: { work_order_id: { in: workOrderIds } },
            select: { work_order_id: true, work_order_no: true },
          });
    const orderNo = new Map(orders.map((o) => [String(o.work_order_id), o.work_order_no]));
    // COMPANY 공지의 분모는 모두 같으므로 한 번만 센다.
    const companyCount = rows.some((row) => row.scope_code === 'COMPANY')
      ? await this.prisma.app_user.count({ where: { is_active: true } })
      : 0;

    return rows.map((row) => ({
      noticeId: Number(row.notice_id),
      title: row.title,
      body: row.content,
      statusCode: statusOf(row, today),
      startDate: row.start_date === null ? today : dateOf(row.start_date),
      ...(row.end_date === null ? {} : { endDate: dateOf(row.end_date) }),
      ...(row.published_at === null ? {} : { publishedAt: row.published_at.toISOString() }),
      ...(row.created_by === null ? {} : { createdBy: Number(row.created_by) }),
      acknowledgeRequired: row.acknowledge_required,
      acknowledgedCount: row.notice_acknowledgement.filter((a) => a.acknowledged).length,
      // ⚠ WORK_ORDER 는 분모를 셀 수 없어 비운다 — 화면이 분자만 그린다(계약).
      targetCount: row.scope_code === 'COMPANY' ? companyCount : null,
      versionNo: row.version_no,
      scopeCode: row.scope_code ?? 'COMPANY',
      targetWorkOrderId: row.target_work_order_id === null ? null : Number(row.target_work_order_id),
      targetWorkOrderNo:
        row.target_work_order_id === null ? null : orderNo.get(String(row.target_work_order_id)) ?? null,
    }));
  }

  private async row(noticeId: number): Promise<NoticeRow> {
    const row = await this.prisma.notice.findUnique({
      where: { notice_id: noticeId },
      include: { notice_acknowledgement: true },
    });
    if (!row) throw new NotFoundException('없는 공지입니다.');
    return row;
  }

  /**
   * `notice.notice_no` 는 NOT NULL·유일인데 **계약에 그 칸이 없다** — 주는 사람이 없어
   * 서버가 짓는다. 채번 규칙(`app.numbering_rule`)에는 실적 하나뿐이라 형식도 우리가 정했다.
   * 되돌림 §Y-6 에 적었다. 같은 날 동시에 만들면 부딪히므로 몇 번 다시 뽑는다.
   */
  private async nextNoticeNo(): Promise<string> {
    const day = dateOf(todayUtc()).replace(/-/g, '');
    const used = await this.prisma.notice.count({ where: { notice_no: { startsWith: `NTC-${day}-` } } });
    return `NTC-${day}-${String(used + 1).padStart(4, '0')}`;
  }
}

function assertStatus(value: string | undefined): NoticeStatus | undefined {
  if (value === undefined) return undefined;
  if ((NOTICE_STATUSES as readonly string[]).includes(value)) return value as NoticeStatus;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'field',
      field: 'statusCode',
      code: ERROR_CODE.INVALID,
      message: `${NOTICE_STATUSES.join(' · ')} 중 하나입니다.`,
    },
  ]);
}

/** ⚠ 공지는 공장에 매이지 않아 로컬 오늘을 풀 근거가 없다 — UTC 로 둔다(되돌림 §Y-4). */
function todayUtc(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function date(field: string, value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message: 'YYYY-MM-DD 형식입니다.' },
  ]);
}

function bool(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function loose(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
