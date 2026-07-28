import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * 재전송 식별자. **전 쓰기 API 필수** — 기술스택-배포모델 결정서 §160 계약 표준 헤더.
 *
 * POP은 오프라인 버퍼링(결정 17) 때문에 재전송이 실제로 일어난다. 같은 키의 재요청은
 * 새로 만들지 않고 처음 만든 결과를 그대로 돌려준다(설계검토 §138).
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** 키 길이 상한 — idempotency_key 컬럼이 varchar(150)이다. */
const MAX_LENGTH = 150;

/**
 * 헤더에서 재전송 식별자를 꺼낸다. 없으면 400 — **기본값을 만들어 주지 않는다.**
 * 서버가 임의로 채우면 재전송마다 다른 키가 되어 멱등성이 조용히 사라진다.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const header = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers[
    IDEMPOTENCY_KEY_HEADER
  ];

  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new BadRequestException(
      `${IDEMPOTENCY_KEY_HEADER} 헤더가 필요합니다. 요청마다 새 UUID를 생성해 보내고, ` +
        '재전송할 때는 처음 보낸 값을 그대로 다시 보내십시오.',
    );
  }

  const key = header.trim();
  if (key.length > MAX_LENGTH) {
    throw new BadRequestException(`${IDEMPOTENCY_KEY_HEADER}는 ${MAX_LENGTH}자를 넘을 수 없습니다.`);
  }
  return key;
});
