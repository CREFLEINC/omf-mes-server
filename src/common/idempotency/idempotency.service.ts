import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { ConflictException } from '../errors';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 기록이 언제까지 유효한가. 계약이 정하지 않은 운영 파라미터라 상수로 둔다 —
 * `app.operation_policy` 로 옮길 자리이나 값이 확정되지 않았다.
 * 오프라인 큐가 하루를 넘겨 재전송할 수 있어(C-6 로컬 버퍼링) 넉넉히 잡는다.
 */
const RETENTION_HOURS = 72;

/**
 * 계열 봉투 넷의 `code` enum **교집합**. ⛔ `string` 으로 열어 두지 않는다 — 호출부 28곳에
 * 넘기는 값이라 교집합 밖 문자열이 들어가면 어느 한 계열에서 계약을 깨는데, 다섯째 인자가
 * 선택이라 그것을 잡아 줄 다른 그물이 없다(#414 리뷰 m-4).
 */
export type FamilyConflictCode = 'VERSION_CONFLICT' | 'DUPLICATE_KEY' | 'INVALID_STATE';

/** 멱등 흡수가 내는 409 두 갈래에 실을 계열 봉투의 `code`. */
export interface IdempotencyConflictCode {
  /** 같은 키로 «다른» 내용이 왔을 때. */
  duplicate: FamilyConflictCode;
  /** 앞의 처리가 아직 안 끝났을 때. */
  inProgress: FamilyConflictCode;
}

/**
 * 계열 봉투 넷이 «모두» 가진 두 값 — 계약 실측(`contracts/COMMIT.txt` = `a6a87e1`)이다.
 * `Production`·`Quality`·`Shipment`·`StockReinstatement` 네 `*ConflictResponse` 의 `code`
 * enum 교집합이 `VERSION_CONFLICT`·`DUPLICATE_KEY`·`INVALID_STATE` 셋이라 계열마다 상수를
 * 가르지 않는다 — 갈라도 값이 같다.
 *
 * ⛔ 「처리 중」에 `CANCEL_IN_PROGRESS` 를 쓰지 않는다 — shipment 계열에만 있고 뜻이
 * 「취소가 진행 중」이라 다르다. 결정 — 통보 077.
 *
 * ⚠ `INVALID_STATE` 는 이 저장소에서 이미 「**문서 상태가 막는다**」(되돌릴 수 없는 거부)로
 * 쓰인다 — `inspection-result-write.service.ts` 의 확정본 수정 · `production-plan.service.ts`
 * 의 확정 계획 삭제. 여기서 내는 것은 그 반대로 «**재시도하면 풀린다**»이고, 두 사건을 가르는
 * 것은 `code` 가 아니라 **`conflictCause`**(`workerLease` vs `user`)뿐이다. 화면·오프라인 큐가
 * `code` 만 보고 분기하면 재시도할 요청을 버린다(#414 리뷰 m-1 · 통보 077 §「같은 값의 두 뜻」).
 */
export const FAMILY_CONFLICT_CODE: IdempotencyConflictCode = {
  duplicate: 'DUPLICATE_KEY',
  inProgress: 'INVALID_STATE',
};

export interface IdempotencyContext {
  key: string;
  /** 같은 키로 «다른» 요청이 오면 가려낸다. */
  fingerprint: string;
  appUserId?: number;
  /** 처음 처리했을 때 낼 상태. 재전송에는 저장된 값을 그대로 쓴다. */
  successStatus: number;
  /**
   * ⛔ 계열 봉투(`code` 가 required)를 쓰는 오퍼레이션만 준다 — 안 주면 봉투는 오늘과
   * «글자 그대로» 같다. `app`·`mdm`·`logistics`·`equipment` 의 `ConflictResponse` 에는
   * `code` 프로퍼티 «자체»가 없어 실으면 계약에 없는 칸이 된다. 한 컨트롤러 파일 안에서도
   * 오퍼레이션마다 갈린다 — `work-order.controller.ts` 의 자원계획 2건이 그 자리다.
   */
  conflictCode?: IdempotencyConflictCode;
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

/**
 * 계열 봉투를 쓰는 오퍼레이션만 `code` 를 얹는다. 안 준 도메인은 `{}` 라 봉투가 오늘과
 * 바이트 단위로 같다(`app` 의 `Object.keys(body)` 단언이 그 그물이다).
 */
function codeOf(
  context: IdempotencyContext,
  branch: keyof IdempotencyConflictCode,
): { code?: string } {
  return context.conflictCode === undefined ? {} : { code: context.conflictCode[branch] };
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
      // ⛔ 봉투는 ConflictResponse 다 — 계약이 409 에 그것을 선언했다.
      // 원인은 「사람」이다: 클라이언트가 키를 재사용했다.
      throw new ConflictException(
        'user',
        '같은 요청 키로 다른 내용이 왔습니다. 새 키로 보내세요.',
        codeOf(context, 'duplicate'),
      );
    }

    if (record.status !== 'COMPLETED') {
      // 앞의 처리가 아직 끝나지 않았다. 재로드로 풀릴 수 있으므로 저장 충돌 쪽이다.
      // 앞의 처리가 아직 «잡고 있다» — 계약 어휘로 workerLease 다.
      throw new ConflictException(
        'workerLease',
        '같은 요청이 처리 중입니다. 잠시 뒤 다시 확인하세요.',
        codeOf(context, 'inProgress'),
      );
    }

    return {
      replayed: true,
      status: record.response_status ?? context.successStatus,
      body: record.response_body as T,
    };
  }
}
