import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const RETENTION_HOURS = 24;

/**
 * `IN_PROGRESS` 가 이 시간을 넘기면 처리하던 주체가 죽은 것으로 본다.
 *
 * 기준정보 쓰기는 검증 조회 5회 + INSERT 로 보통 100ms 안쪽이다 — 백 배 여유가 있어
 * 살아 있는 요청을 가로챌 위험이 없고, 서버가 죽었을 때 사용자는 1분만 기다리면 된다.
 * 이 값이 없으면 그 키가 보관 기간(24시간) 내내 409 를 낸다.
 */
const STALE_SECONDS = 60;

/** 정리 한 번에 지우는 최대 행수. 쓰기 응답을 붙잡지 않을 만큼만 지운다. */
const SWEEP_LIMIT = 100;

export type StoredResponse = { status: number; body: unknown };

export type Lookup =
  | { kind: 'fresh' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'mismatch' }
  | { kind: 'inProgress' };

@Injectable()
export class IdempotencyStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 키를 선점한다. `fresh` 면 호출부가 핸들러를 돌린다.
   *
   * 선점과 처리를 한 트랜잭션에 묶지 않는다 — 커밋되어야 다른 요청이 `IN_PROGRESS` 를
   * 볼 수 있고, 그래야 동시 재전송을 409 로 막는다.
   */
  async claim(key: string, fingerprint: string, appUserId?: bigint): Promise<Lookup> {
    const existing = await this.prisma.idempotency_record.findUnique({
      where: { idempotency_key: key },
    });

    if (!existing) {
      try {
        await this.insert(key, fingerprint, appUserId);

        return { kind: 'fresh' };
      } catch (error) {
        // 선제 조회를 둘이 함께 통과했다. 진 쪽은 처리 중인 요청이 있는 것으로 본다.
        if (isUniqueViolation(error)) return { kind: 'inProgress' };
        throw error;
      }
    }

    if (existing.request_fingerprint !== fingerprint) return { kind: 'mismatch' };

    if (existing.status === 'COMPLETED') {
      return {
        kind: 'replay',
        response: { status: existing.response_status ?? 200, body: existing.response_body },
      };
    }

    const staleBefore = new Date(Date.now() - STALE_SECONDS * 1000);
    if (existing.created_at >= staleBefore) return { kind: 'inProgress' };

    // 처리하던 주체가 죽었다. 시작 시각을 갱신해 이어받는다.
    //
    // 조건 없이 갱신하면 죽은 기록을 동시에 본 둘이 **함께 이어받아 핸들러가 두 번
    // 돈다** — 멱등이 깨지는 바로 그 경우다. WHERE 에 상태와 시각을 넣어 행 단위
    // 비교-교환으로 만든다. 진 쪽은 갱신 건수가 0 이다.
    //
    // **이 조건절은 테스트로 덮이지 않는다.** 조회와 갱신 사이의 창이 좁아 요청 둘로는
    // 재현되지 않고, 재현되더라도 조건절이 없는 판본과 결과가 같아 보인다. 두 트랜잭션의
    // 순서를 손으로 엮어야 갈리는데 claim 에 그 이음매가 없다. 고치는 비용이 0 이라 둔다.
    const { count } = await this.prisma.idempotency_record.updateMany({
      where: {
        idempotency_key: key,
        status: 'IN_PROGRESS',
        created_at: { lt: staleBefore },
      },
      data: { created_at: new Date(), app_user_id: appUserId ?? null },
    });

    return count === 1 ? { kind: 'fresh' } : { kind: 'inProgress' };
  }

  /** 기록이 사라졌으면 아무 일도 하지 않는다 — `update` 는 P2025 를 던져 성공한 쓰기가 404 가 된다. */
  async complete(key: string, response: StoredResponse): Promise<void> {
    await this.prisma.idempotency_record.updateMany({
      where: { idempotency_key: key },
      data: {
        status: 'COMPLETED',
        response_status: response.status,
        response_body: response.body as Prisma.InputJsonValue,
        completed_at: new Date(),
      },
    });
  }

  /**
   * 기록을 지워 같은 키로 다시 시도할 수 있게 한다.
   *
   * 5xx 에 쓴다 — 일시적일 수 있는 오류를 저장하면 DB 가 잠시 끊겨 500 이 난 요청이
   * 보관 기간 내내 재시도해도 500 을 받는다.
   */
  async release(key: string): Promise<void> {
    await this.prisma.idempotency_record.deleteMany({ where: { idempotency_key: key } });
  }

  /**
   * 만료분을 조금씩 지운다. 스케줄러를 새로 들이지 않으려고 쓰기에 얹었다 —
   * 「나중에 정리 붙이기」를 잊을 여지가 없다.
   */
  async sweepExpired(): Promise<number> {
    const expired = await this.prisma.idempotency_record.findMany({
      where: { expires_at: { lt: new Date() } },
      select: { idempotency_key: true },
      take: SWEEP_LIMIT,
    });
    if (expired.length === 0) return 0;

    const { count } = await this.prisma.idempotency_record.deleteMany({
      where: { idempotency_key: { in: expired.map((row) => row.idempotency_key) } },
    });

    return count;
  }

  private async insert(key: string, fingerprint: string, appUserId?: bigint): Promise<void> {
    await this.prisma.idempotency_record.create({
      data: {
        idempotency_key: key,
        request_fingerprint: fingerprint,
        status: 'IN_PROGRESS',
        app_user_id: appUserId ?? null,
        expires_at: new Date(Date.now() + RETENTION_HOURS * 3_600_000),
      },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
