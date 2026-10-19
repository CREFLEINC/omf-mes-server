/**
 * ERP 연동 리스 — 블루-그린 전환 중 api 둘 중 한 쪽만 회차를 돈다.
 * 중계 DB 없이 Postgres 만으로 돈다.
 */
import { SyncLease } from '../src/integration/erp/sync-lease';
import { PrismaService } from '../src/prisma/prisma.service';

const NAME = 'e2e-erp-sync-lease';

describe('ERP 연동 리스 (e2e)', () => {
  let prisma: PrismaService;
  let blue: SyncLease;
  let green: SyncLease;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    blue = new SyncLease(prisma, NAME);
    green = new SyncLease(prisma, NAME);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  const cleanup = () => prisma.sync_lease.deleteMany({ where: { lease_name: NAME } });

  it('먼저 잡은 쪽만 쥐고, 쥔 쪽은 늘릴 수 있다', async () => {
    expect(await blue.acquire()).toBe(true);
    expect(await green.acquire()).toBe(false);
    // 곧 만료될 리스로 만들어 둔다 — 늘리면 120초 뒤로 밀려야 한다.
    await prisma.sync_lease.update({
      where: { lease_name: NAME },
      data: { expires_at: new Date(Date.now() + 5_000) },
    });

    expect(await blue.acquire()).toBe(true);

    const lease = await prisma.sync_lease.findUniqueOrThrow({ where: { lease_name: NAME } });
    expect(lease.owner_token).toBe(blue.owner);
    expect(lease.expires_at.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it('쥔 쪽이 죽어 만료되면 다른 쪽이 가져간다', async () => {
    await prisma.sync_lease.update({
      where: { lease_name: NAME },
      data: { expires_at: new Date(Date.now() - 1_000) },
    });

    expect(await green.acquire()).toBe(true);
    expect(await blue.acquire()).toBe(false);
  });

  it('남에게 넘어간 리스는 놓지 않고, 내 것만 놓는다', async () => {
    await blue.release();
    expect(await prisma.sync_lease.findUnique({ where: { lease_name: NAME } })).toMatchObject({
      owner_token: green.owner,
    });

    await green.release();

    expect(await prisma.sync_lease.findUnique({ where: { lease_name: NAME } })).toBeNull();
    expect(await blue.acquire()).toBe(true);
  });
});
