import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { ContractException, ERROR_CODE } from '../errors';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 기록이 언제까지 유효한가. 계약이 정하지 않은 운영 파라미터라 상수로 둔다 —
 * `app.operation_policy` 로 옮길 자리이나 값이 확정되지 않았다.
 * 오프라인 큐가 하루를 넘겨 재전송할 수 있어(C-6 로컬 버퍼링) 넉넉히 잡는다.
 */
const RETENTION_HOURS = 72;

export interface IdempotencyContext {
  key: string;
  /** 같은 키로 «다른» 요청이 오면 가려낸다. */
  fingerprint: string;
  appUserId?: number;
  /** 처음 처리했을 때 낼 상태. 재전송에는 저장된 값을 그대로 쓴다. */
  successStatus: number;
}

export interface IdempotentOutcome<T> {
  replayed: boolean;
  status: number;
  body: T;
}

/** `METHOD path` 와 본문으로 요청의 지문을 만든다. 키가 같아도 내용이 다르면 갈린다. */
export function requestFingerprint(operation: string, body: unknown): string {
  return createHash('sha256').update(`${operation}\n${stableJson(body)}`).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  // 키 순서가 달라도 같은 요청이다 — JSON.stringify 는 그것을 다르게 본다.
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 한 오퍼레이션 = 한 트랜잭션 = 한 멱등 기록.
   *
   * ⛔ 기록이 업무와 «같은» 트랜잭션에 든다. 밖에 두면 둘이 어긋난다 — 업무가 커밋됐는데
   * 기록이 실패하면 재전송이 영원히 막히고, 업무가 실패했는데 기록이 남으면 재시도가
   * 막힌다. 함께 롤백되어야 「안 한 일」이 된다(구조설계 C-5).
   */
  async run<T>(
    context: IdempotencyContext,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    const seen = await this.prisma.idempotency_record.findUnique({
      where: { idempotency_key: context.key },
    });
    if (seen) return this.replay<T>(seen, context);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.idempotency_record.create({
          data: {
            idempotency_key: context.key,
            request_fingerprint: context.fingerprint,
            status: 'IN_PROGRESS',
            expires_at: new Date(Date.now() + RETENTION_HOURS * 3600_000),
            ...(context.appUserId === undefined ? {} : { app_user_id: context.appUserId }),
          },
        });

        const body = await work(tx);

        await tx.idempotency_record.update({
          where: { idempotency_key: context.key },
          data: {
            status: 'COMPLETED',
            response_status: context.successStatus,
            response_body: body === undefined ? Prisma.DbNull : (body as Prisma.InputJsonValue),
            completed_at: new Date(),
          },
        });

        return { replayed: false, status: context.successStatus, body };
      });
    } catch (error) {
      // 같은 키가 동시에 들어와 PK 로 부딪혔다. 먼저 든 쪽이 처리 중이거나 끝냈다.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('idempotency')
      ) {
        const now = await this.prisma.idempotency_record.findUnique({
          where: { idempotency_key: context.key },
        });
        if (now) return this.replay<T>(now, context);
      }
      throw error;
    }
  }

  private replay<T>(
    record: { request_fingerprint: string; status: string; response_status: number | null; response_body: Prisma.JsonValue | null },
    context: IdempotencyContext,
  ): IdempotentOutcome<T> {
    if (record.request_fingerprint !== context.fingerprint) {
      // 같은 키로 «다른» 요청이 왔다. 앞의 응답을 주면 거짓말이 된다.
      throw new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '같은 요청 키로 다른 내용이 왔습니다. 새 키로 보내세요.',
        },
      ]);
    }

    if (record.status !== 'COMPLETED') {
      // 앞의 처리가 아직 끝나지 않았다. 재로드로 풀릴 수 있으므로 저장 충돌 쪽이다.
      throw new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '같은 요청이 처리 중입니다. 잠시 뒤 다시 확인하세요.',
        },
      ]);
    }

    return {
      replayed: true,
      status: record.response_status ?? context.successStatus,
      body: record.response_body as T,
    };
  }
}
