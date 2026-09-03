import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  ErrorItem,
} from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 연계 메시지 상태.
 *
 * ⚠ 계약이 「공통코드 — **값 목록이 아직 서지 않았다**. 최소 구분: 대기/처리중/완료/실패」
 * 로 적었다(추적처 `omf-mes#213`). 그런데 `:retry` 는 「`statusCode`=**실패** 이고
 * `lockedBy` 가 비어 있어야 한다」라 그 낱말이 어떤 문자열인지 알아야 선다.
 *
 * 근거 셋을 모아 넷을 적었다.
 *   1. 계약 자신이 `statusCode` 의 `example` 로 `FAILED` 를 보였다.
 *   2. 설계의 웹프론트 착수안내가 재처리 화면 목업에 `statusCode: FAILED` 를 썼다.
 *   3. 이 표에 쓰는 «워커»가 아직 없다 — 어긋날 기존 데이터가 없다.
 *
 * ⛔ **금형(`MOLD_STATUS`)과 갈리는 지점이 여기다.** 그쪽은 시드 4값이 계약 2값과
 * «어긋나» 어느 쪽도 고를 수 없었다. 여기는 시드도 CHECK 도 없고 계약의 예시와 설계
 * 목업이 같은 값을 가리킨다 — 모름이지 모순이 아니다.
 *
 * 값이 다르게 정해지면 **이 상수 한 줄**을 바꾼다. 되돌림 §X-4.
 */
export const MESSAGE_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

/** 계약 `IntegrationMessage` 와 동형. ⛔ `payload` 는 여기 없다 — 상세에만 있다. */
interface MessageView {
  integrationMessageId: number;
  messageKey: string;
  interfaceCode: string;
  directionCode: string;
  targetTypeCode: string;
  targetId: number;
  statusCode: string;
  retryCount: number;
  lastErrorMessage: string | null;
  createdAt: string;
  availableAt: string;
  sentAt: string | null;
  completedAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
}

export interface MessageQuery {
  createdFrom: string;
  createdTo: string;
  statusCode?: string;
  interfaceCode?: string;
  directionCode?: string;
  targetTypeCode?: string;
  retryCountMin?: number;
  page?: number;
  size?: number;
}

/** 계약 `BatchResult` 와 동형. */
export interface BatchResult {
  succeeded: number;
  failed: { index: number; key?: string; errors: ErrorItem[] }[];
}

type MessageRow = Prisma.integration_messageGetPayload<object>;

/** 연계 메시지. 화면은 `W-06-10`(연계 동기화 현황·실패 재처리)이 소유한다. */
@Injectable()
export class IntegrationMessageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 「이 화면의 본질은 «비동기 워커의 상태를 사람이 읽고 개입하는 창»이다」(계약).
   * `createdFrom`·`createdTo` 는 필수다 — 「기간 미지정 조회는 제공하지 않는다」.
   */
  async list(query: MessageQuery): Promise<PagedResponse<MessageView>> {
    const page = pageRequest(query);
    const where: Prisma.integration_messageWhereInput = {
      created_at: { gte: new Date(query.createdFrom), lte: new Date(query.createdTo) },
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(query.interfaceCode === undefined ? {} : { interface_code: query.interfaceCode }),
      ...(query.directionCode === undefined ? {} : { direction_code: query.directionCode }),
      ...(query.targetTypeCode === undefined ? {} : { target_type_code: query.targetTypeCode }),
      ...(query.retryCountMin === undefined ? {} : { retry_count: { gte: query.retryCountMin } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.integration_message.findMany({
        where,
        // 최근 것이 위다 — 방금 실패한 것을 찾는 화면이다.
        orderBy: { created_at: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.integration_message.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  /**
   * ⚠ 상세만 `payload` 를 낸다. 계약이 이유를 적었다 — 「payload 는 거래처·단가·수량 등
   * **대외비**를 담을 수 있어 노출 범위가 확정되지 않았고, 권한이 없으면 이 응답 자체가
   * 403 이다」. 목록이 전 행의 payload 를 나르지 않게 스키마를 갈라 두었다.
   */
  async get(messageId: number): Promise<MessageView & { payload: unknown }> {
    const row = await this.load(messageId);
    return { ...view(row), payload: row.payload };
  }

  /**
   * 「`message_key` 가 UNIQUE 라 재처리는 **중복 전송이 아니다** — 같은 메시지 키로 다시
   * 시도한다」(계약).
   *
   * ⛔ 두 조건을 가른다.
   *   `lockedBy` 가 있으면 **409** `conflictCause=workerLease` — 워커가 이미 잡고 있다.
   *     이 표에 `version_no` 가 없어 낙관적 잠금이 아니라 «리스» 충돌이다(`B-1` 확장·`C-4`).
   *   상태가 실패가 아니면 **400** `NOT_RETRYABLE`.
   *
   * ⛔ 「화면은 리스가 오래돼도 임의로 락을 풀지 않는다」(계약 §5-4) — 서버도 안 푼다.
   */
  async retry(messageId: number): Promise<MessageView> {
    const row = await this.load(messageId);
    const failure = retryBlocker(row);
    if (failure !== undefined) throw failure;

    // 다음 시도를 «지금»으로 당긴다 — 백오프가 미뤄 둔 시각을 사람이 앞당기는 것이
    // 이 액션의 뜻이다. 시도 횟수는 워커가 올린다.
    const updated = await this.prisma.integration_message.updateMany({
      where: {
        integration_message_id: messageId,
        status_code: MESSAGE_STATUS.FAILED,
        locked_by: null,
      },
      data: { status_code: MESSAGE_STATUS.PENDING, available_at: new Date() },
    });
    // 0행이면 그 사이 워커가 집어 갔다 — 리스 충돌과 같은 뜻이다.
    if (updated.count === 0) {
      throw new ConflictException('workerLease', '다른 처리가 이 메시지를 먼저 집었습니다.');
    }

    return view(await this.load(messageId));
  }

  /**
   * 「**부분 실패를 허용한다** — 전체 롤백하지 않는다」(공유계약 `C-2`).
   * 조건을 만족하지 않는 건은 `BatchResult.failed` 에 **개별 사유**로 담긴다.
   */
  async retryBatch(messageIds: number[]): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: [] };

    for (const [index, messageId] of messageIds.entries()) {
      const row = await this.prisma.integration_message.findUnique({
        where: { integration_message_id: messageId },
      });
      if (!row) {
        result.failed.push({
          index,
          key: String(messageId),
          errors: [
            {
              scope: 'screen',
              code: ERROR_CODE.INVALID,
              message: '없는 연계 메시지입니다.',
            },
          ],
        });
        continue;
      }

      const blocker = retryBlocker(row);
      if (blocker !== undefined) {
        result.failed.push({ index, key: row.message_key, errors: blockerErrors(blocker) });
        continue;
      }

      const updated = await this.prisma.integration_message.updateMany({
        where: {
          integration_message_id: messageId,
          status_code: MESSAGE_STATUS.FAILED,
          locked_by: null,
        },
        data: { status_code: MESSAGE_STATUS.PENDING, available_at: new Date() },
      });
      if (updated.count === 0) {
        result.failed.push({
          index,
          key: row.message_key,
          errors: [
            {
              scope: 'screen',
              code: ERROR_CODE.STATE_LOCKED,
              message: '다른 처리가 이 메시지를 먼저 집었습니다.',
            },
          ],
        });
        continue;
      }
      result.succeeded += 1;
    }

    return result;
  }

  private async load(messageId: number): Promise<MessageRow> {
    const row = await this.prisma.integration_message.findUnique({
      where: { integration_message_id: messageId },
    });
    if (!row) throw new NotFoundException('없는 연계 메시지입니다.');
    return row;
  }
}

/** 재처리를 막는 사유. 없으면 `undefined`. 단건과 일괄이 «같은 판정»을 쓴다. */
function retryBlocker(row: MessageRow): ConflictException | ContractException | undefined {
  if (row.locked_by !== null) {
    return new ConflictException(
      'workerLease',
      '워커가 이 메시지를 처리 중입니다. 잠시 뒤 다시 확인하세요.',
    );
  }
  if (row.status_code !== MESSAGE_STATUS.FAILED) {
    return new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'screen',
        code: ERROR_CODE.NOT_RETRYABLE,
        message: `실패한 메시지만 재처리할 수 있습니다(지금 ${row.status_code}).`,
      },
    ]);
  }
  return undefined;
}

/** 일괄은 봉투가 하나라 사유를 `ErrorItem` 으로 편다. */
function blockerErrors(blocker: ConflictException | ContractException): ErrorItem[] {
  if (blocker instanceof ContractException) return blocker.errors;
  return [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: blocker.conflict.message,
    },
  ];
}

function view(row: MessageRow): MessageView {
  return {
    integrationMessageId: Number(row.integration_message_id),
    messageKey: row.message_key,
    interfaceCode: row.interface_code,
    directionCode: row.direction_code,
    targetTypeCode: row.target_type_code,
    targetId: Number(row.target_id),
    statusCode: row.status_code,
    retryCount: row.retry_count,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at.toISOString(),
    availableAt: row.available_at.toISOString(),
    sentAt: row.sent_at === null ? null : row.sent_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    lockedAt: row.locked_at === null ? null : row.locked_at.toISOString(),
    lockedBy: row.locked_by,
  };
}
