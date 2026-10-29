import { WORKER_DB_BASE, workerDatabaseUrl } from './worker-db';

// 스위트가 앱을 띄우기 «전»에 돈다(jest `setupFiles`) — Prisma 는 만들어질 때 DATABASE_URL 을 읽는다.
const base = process.env[WORKER_DB_BASE];
if (base !== undefined) process.env.DATABASE_URL = workerDatabaseUrl(base, process.env.JEST_WORKER_ID ?? '1');
