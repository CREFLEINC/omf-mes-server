import { SetMetadata } from '@nestjs/common';

export const SKIP_IDEMPOTENCY_KEY = 'idempotency:skip';

/**
 * 계약 밖의 쓰기에 붙인다 — 로그인처럼 `mdm-기준정보.json` 이 다루지 않는 것들.
 *
 * 기본이 「멱등 키를 요구함」이라 새 쓰기를 만들며 깜빡해도 보호된 채로 시작한다.
 * 가드의 `@Public()` 과 같은 방향이다.
 */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY_KEY, true);
