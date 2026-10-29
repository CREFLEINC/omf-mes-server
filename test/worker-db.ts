/** 병렬 e2e 에서 원본 DB 주소를 일꾼에게 넘기는 환경 변수 — `global-setup.ts` 가 복사를 마친 뒤에 둔다. */
export const WORKER_DB_BASE = 'E2E_WORKER_DB_BASE';

/**
 * 일꾼 `worker` 의 DB 주소 — 원본 이름에 `_w<번호>` 를 붙인다. 연결 수를 일꾼마다 10 으로 묶는다 —
 * Prisma 기본은 「CPU × 2 + 1」이라 일꾼 여럿이면 PostgreSQL 한도(100)를 넘는다.
 */
export function workerDatabaseUrl(base: string, worker: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}_w${worker}`;
  url.searchParams.set('connection_limit', '10');
  return url.toString();
}
