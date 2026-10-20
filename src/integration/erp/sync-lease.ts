import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { PrismaService } from '../../prisma/prisma.service';

/** 실행기의 리스 이름 — 연동 현황(P-79)이 「지금 도는 중」을 가를 때 이 줄의 만료를 본다. */
export const ERP_SYNC_LEASE = 'erp-sync';

/**
 * 「한 쪽만 돈다」 — 블루-그린 전환 중에는 api 가 둘 떠 있다. 쥔 쪽만 회차를 돈다.
 * 쥔 쪽이 묶음마다 늘리고, 죽으면 120초 뒤 다른 쪽이 가져간다.
 */
export class SyncLease {
  /** 컨테이너 id(hostname)·pid 를 넣어 로그에서 누가 쥐었는지 보이게 한다. */
  readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly name = ERP_SYNC_LEASE,
  ) {}

  /** 잡거나 늘린다. 남이 쥐고 있고 아직 안 끝났으면 false. */
  async acquire(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ owner_token: string }[]>`
      INSERT INTO integration.sync_lease (lease_name, owner_token, expires_at)
      VALUES (${this.name}, ${this.owner}, clock_timestamp() + interval '120 seconds')
      ON CONFLICT (lease_name) DO UPDATE
         SET owner_token = EXCLUDED.owner_token, expires_at = EXCLUDED.expires_at
       WHERE integration.sync_lease.expires_at <= clock_timestamp()
          OR integration.sync_lease.owner_token = EXCLUDED.owner_token
      RETURNING owner_token`;
    return rows.length === 1;
  }

  /** 내 것일 때만 놓는다 — 이미 남에게 넘어갔으면 건드리지 않는다. */
  async release(): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM integration.sync_lease WHERE lease_name = ${this.name} AND owner_token = ${this.owner}`;
  }
}
