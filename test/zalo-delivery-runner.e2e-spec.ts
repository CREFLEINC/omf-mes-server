/**
 * Zalo 발송 러너 — 대역 + 로컬 DB(omf-all-around#160 · 장부 P-97).
 *
 * 러너를 직접 만들고 `tick(now)` 를 부른다(e2e 전역 설정이 앱 안의 러너는 끈다). CI 단위 검사 단계에는
 * DB 가 없어 이 검사는 e2e 에 둔다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SecretBox } from '../src/core/crypto/secret-box';
import { SyncLease } from '../src/integration/erp/sync-lease';
import { ZaloClient } from '../src/integration/zalo/zalo-client';
import { BACKOFF_MS, ZaloDeliveryRunner } from '../src/integration/zalo/zalo-delivery.runner';
import { nextSiteMorning } from '../src/integration/zalo/zalo-error-policy';
import { ZaloTokenService } from '../src/integration/zalo/zalo-token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ZaloStub, startZaloStub } from './support/zalo-stub';

const PREFIX = `ZRUN${randomUUID().slice(0, 6)}`;
const EVENT = 'WORK_SESSION_STARTED';
const NOW = new Date('2026-10-21T03:00:00.000Z'); // 하노이 10:00
const HOUR = 60 * 60 * 1000;

describe('Zalo 발송 러너 (e2e · 대역)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stub: ZaloStub;
  let box: SecretBox;
  let runner: ZaloDeliveryRunner;
  let recipientId: bigint;
  const eventIds: bigint[] = [];
  let sequence = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    stub = await startZaloStub();
    box = new SecretBox(process.env.ZALO_CREDENTIAL_KEY as string);
    const client = new ZaloClient({ apiBaseUrl: stub.url, oauthBaseUrl: stub.url, timeoutMs: 2000 });
    runner = new ZaloDeliveryRunner(true, prisma, new SyncLease(prisma, `${PREFIX}-lease`), client, new ZaloTokenService(prisma, box, client));

    recipientId = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-R`, user_name: '수신자', status_code: 'EMPLOYED' } })).app_user_id;
  });

  beforeEach(async () => {
    stub.reset();
    await prisma.zalo_delivery.deleteMany();
    await prisma.zalo_template.deleteMany();
    await prisma.zalo_connection.deleteMany();
    await connection();
    await prisma.zalo_template.create({ data: { event_type_code: EVENT, template_id: 'TPL-START' } });
  });

  afterAll(async () => {
    await prisma.zalo_delivery.deleteMany();
    await prisma.zalo_template.deleteMany();
    await prisma.zalo_connection.deleteMany();
    await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${`${PREFIX}-lease`}`;
    await prisma.notification_event.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.app_user.delete({ where: { app_user_id: recipientId } });
    await stub.close();
    await app.close();
  });

  it('SC-002 SC-009 대기 건을 보내면 SENT·zalo_msg_id·sent_at 이 채워지고 저장된 접속 토큰으로 보낸다', async () => {
    const id = await delivery();
    await runner.tick(NOW);

    expect(await row(id)).toMatchObject({ status_code: 'SENT', attempt_count: 1, zalo_msg_id: expect.stringMatching(/^stub-msg-/) });
    expect((await row(id)).sent_at).not.toBeNull();
    const [sent] = sends();
    expect(sent.headers.access_token).toBe('access-old');
    expect(JSON.parse(sent.body)).toMatchObject({ phone: '84912345678', template_id: 'TPL-START', tracking_id: `zd-${id}` });
  });

  it('US8-2 5xx 는 1분·5분·15분 뒤 같은 건을 다시 보내고 4회 시도 뒤 FAILED 다', async () => {
    const id = await delivery();
    stub.queue({ send: ['http500', 'http500', 'http500', 'http500'] });
    let at = NOW;
    for (const [index, backoff] of BACKOFF_MS.entries()) {
      await runner.tick(at);
      expect(await row(id)).toMatchObject({ status_code: 'PENDING', attempt_count: index + 1, last_error_code: 'HTTP_500' });
      expect((await row(id)).next_attempt_at.getTime()).toBe(at.getTime() + backoff);
      // 백오프 전에는 잡지 않는다.
      await runner.tick(new Date(at.getTime() + backoff - 1000));
      at = new Date(at.getTime() + backoff);
    }
    await runner.tick(at);
    expect(await row(id)).toMatchObject({ status_code: 'FAILED', attempt_count: 4 });
    expect(sends()).toHaveLength(4);
  });

  it('-108(번호 무효)은 재시도 없이 바로 FAILED 다', async () => {
    const id = await delivery();
    stub.queue({ send: ['phone-invalid'] });
    await runner.tick(NOW);
    expect(await row(id)).toMatchObject({ status_code: 'FAILED', attempt_count: 1, last_error_code: '-108' });
  });

  it.each([
    ['night', '-133'],
    ['quota', '-144'],
  ] as const)('%s(%s)는 시도로 세지 않고 다음 07:00(UTC+7)로 미룬다', async (scenario, code) => {
    const id = await delivery();
    stub.queue({ send: [scenario] });
    await runner.tick(NOW);
    expect(await row(id)).toMatchObject({ status_code: 'PENDING', attempt_count: 0, last_error_code: code });
    expect((await row(id)).next_attempt_at.toISOString()).toBe(nextSiteMorning(NOW).toISOString());
  });

  it('US7-2 -124 면 갱신하고 같은 tick 에서 다시 보내며, 새 갱신 토큰을 곧바로 암호화해 저장한다', async () => {
    const id = await delivery();
    stub.queue({ send: ['token-invalid', 'ok'] });
    await runner.tick(NOW);

    expect(stub.requests.map((r) => r.path)).toEqual(['/message/template', '/v4/oa/access_token', '/message/template']);
    expect(await row(id)).toMatchObject({ status_code: 'SENT', attempt_count: 1 });
    const saved = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(box.open(saved.refresh_token_enc as string)).toMatch(/^stub-refresh-/);
    expect(saved.refresh_token_enc).not.toMatch(/stub-refresh/);
    expect(sends()[1].headers.access_token).toBe(box.open(saved.access_token_enc as string));
    expect(saved.status_code).toBe('ACTIVE');
  });

  it('US7-3 갱신에 실패하면 REAUTH_REQUIRED 이고 건은 대기(CONNECTION_NOT_READY)로 남는다', async () => {
    const first = await delivery();
    const second = await delivery();
    stub.queue({ send: ['token-invalid'], refresh: ['refresh-fail'] });
    await runner.tick(NOW);

    const saved = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(saved).toMatchObject({ status_code: 'REAUTH_REQUIRED', last_error_code: '-14014' });
    expect(saved.last_error_message).not.toMatch(/refresh-old|secret/);
    for (const id of [first, second]) {
      expect(await row(id)).toMatchObject({ status_code: 'PENDING', attempt_count: 0, last_error_code: 'CONNECTION_NOT_READY' });
    }
    // 연결이 ACTIVE 가 아니면 다음 회차는 보내지 않는다.
    stub.reset();
    await runner.tick(new Date(NOW.getTime() + 60_000));
    expect(stub.requests).toHaveLength(0);
  });

  it('-124 뒤 갱신이 일시 장애로 실패하면 연결은 ACTIVE 로 두고 무효 접속 토큰을 버려 다음 회차는 갱신부터 한다', async () => {
    const id = await delivery();
    stub.queue({ send: ['token-invalid'], refresh: ['http500'] });
    await runner.tick(NOW);

    const saved = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(saved).toMatchObject({ status_code: 'ACTIVE', access_token_enc: null, last_error_code: 'HTTP_500' });
    expect(await row(id)).toMatchObject({ status_code: 'PENDING', attempt_count: 0, last_error_code: 'CONNECTION_NOT_READY' });

    stub.reset();
    await runner.tick(new Date(NOW.getTime() + 60_000));
    expect(stub.requests.map((r) => r.path)).toEqual(['/v4/oa/access_token', '/message/template']);
    expect(await row(id)).toMatchObject({ status_code: 'SENT' });
  });

  it('US7-2 접속 토큰 만료 5분 전이면 보내기 전에 갱신한다', async () => {
    await prisma.zalo_connection.update({ where: { zalo_connection_id: 1 }, data: { access_token_expires_at: new Date(NOW.getTime() + 4 * 60_000) } });
    await delivery();
    await runner.tick(NOW);
    expect(stub.requests.map((r) => r.path)).toEqual(['/v4/oa/access_token', '/message/template']);
  });

  it('US7-2 갱신 요청 중 관리자가 템플릿만 저장해(판이 올라도) 회전된 새 토큰을 잃지 않는다', async () => {
    const real = new ZaloClient({ apiBaseUrl: stub.url, oauthBaseUrl: stub.url });
    const racing = new ZaloTokenService(prisma, box, {
      refresh: async (...args: Parameters<ZaloClient['refresh']>) => {
        // 갱신이 Zalo 에 가 있는 사이 W-CO-12 가 템플릿만 저장한다 — 판(version_no)만 오른다.
        await prisma.zalo_connection.update({ where: { zalo_connection_id: 1 }, data: { version_no: { increment: 1 } } });
        return real.refresh(...args);
      },
    });
    const access = await racing.access(NOW, true);

    const saved = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(box.open(saved.refresh_token_enc as string)).toMatch(/^stub-refresh-/);
    expect(box.open(saved.access_token_enc as string)).toBe(access?.accessToken);
  });

  it('갱신 요청 중 관리자가 갱신 토큰을 바꿨으면 관리자 값을 덮지 않는다', async () => {
    const real = new ZaloClient({ apiBaseUrl: stub.url, oauthBaseUrl: stub.url });
    const racing = new ZaloTokenService(prisma, box, {
      refresh: async (...args: Parameters<ZaloClient['refresh']>) => {
        await prisma.zalo_connection.update({
          where: { zalo_connection_id: 1 }, data: { refresh_token_enc: box.seal('admin-new'), access_token_enc: null, version_no: { increment: 1 } },
        });
        return real.refresh(...args);
      },
    });
    await racing.access(NOW, true);

    const saved = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(box.open(saved.refresh_token_enc as string)).toBe('admin-new');
    expect(saved.access_token_enc).toBeNull();
  });

  it('US7-2 대기 건이 없어도 12시간마다 갱신한다', async () => {
    await prisma.zalo_connection.update({ where: { zalo_connection_id: 1 }, data: { last_refreshed_at: new Date(NOW.getTime() - 13 * HOUR) } });
    await runner.tick(NOW);
    expect(stub.requests.map((r) => r.path)).toEqual(['/v4/oa/access_token']);

    stub.reset();
    await runner.tick(new Date(NOW.getTime() + 60_000));
    expect(stub.requests).toHaveLength(0);
  });

  it('expires_at 이 지난 대기 건은 보내지 않고 EXPIRED 다', async () => {
    const id = await delivery({ expires_at: new Date(NOW.getTime() - 1000) });
    await runner.tick(NOW);
    expect(await row(id)).toMatchObject({ status_code: 'EXPIRED' });
    expect(sends()).toHaveLength(0);
  });

  it('FR-026 SENDING 이 리스 TTL(120초) 넘게 남으면 다시 보내지 않고 FAILED UNKNOWN_OUTCOME 이다', async () => {
    const id = await delivery({ status_code: 'SENDING', updated_at: new Date(NOW.getTime() - 121_000) });
    const fresh = await delivery({ status_code: 'SENDING', updated_at: new Date(NOW.getTime() - 30_000) });
    await runner.tick(NOW);

    expect(await row(id)).toMatchObject({ status_code: 'FAILED', last_error_code: 'UNKNOWN_OUTCOME' });
    expect(await row(fresh)).toMatchObject({ status_code: 'SENDING' });
    expect(sends()).toHaveLength(0);
  });

  it.each(['NOT_CONFIGURED', 'REAUTH_REQUIRED'])(
    'FR-032 연결이 %s 이면 보내지 않고 만료는 처리하며, 남은 대기 건에 CONNECTION_NOT_READY 를 남긴다(시도 수 그대로)',
    async (status) => {
      await prisma.zalo_connection.update({ where: { zalo_connection_id: 1 }, data: { status_code: status } });
      const waiting = await delivery();
      const retried = await delivery();
      await prisma.zalo_delivery.update({ where: { zalo_delivery_id: retried }, data: { attempt_count: 2, last_error_code: 'HTTP_500' } });
      const stale = await delivery({ expires_at: new Date(NOW.getTime() - 1000) });
      await runner.tick(NOW);

      expect(await row(waiting)).toMatchObject({ status_code: 'PENDING', attempt_count: 0, last_error_code: 'CONNECTION_NOT_READY' });
      expect(await row(retried)).toMatchObject({ status_code: 'PENDING', attempt_count: 2, last_error_code: 'CONNECTION_NOT_READY' });
      expect(await row(stale)).toMatchObject({ status_code: 'EXPIRED' });
      expect(stub.requests).toHaveLength(0);

      // 보류 중에도 만료 시간은 흐른다.
      await runner.tick(new Date(NOW.getTime() + 25 * HOUR));
      expect(await row(waiting)).toMatchObject({ status_code: 'EXPIRED' });
    },
  );

  it('FR-032 연결이 다시 ACTIVE 가 되면 보류했던 건을 평소대로 보낸다', async () => {
    await prisma.zalo_connection.update({ where: { zalo_connection_id: 1 }, data: { status_code: 'REAUTH_REQUIRED' } });
    const id = await delivery();
    await runner.tick(NOW);
    expect(await row(id)).toMatchObject({ status_code: 'PENDING', last_error_code: 'CONNECTION_NOT_READY' });

    await prisma.zalo_connection.update({ where: { zalo_connection_id: 1 }, data: { status_code: 'ACTIVE' } });
    await runner.tick(new Date(NOW.getTime() + 60_000));
    expect(await row(id)).toMatchObject({ status_code: 'SENT', attempt_count: 1, last_error_code: null });
    expect(sends()).toHaveLength(1);
  });

  it('템플릿 ID 가 없는 이벤트는 FAILED TEMPLATE_NOT_SET 이다', async () => {
    await prisma.zalo_template.deleteMany();
    const id = await delivery();
    await runner.tick(NOW);
    expect(await row(id)).toMatchObject({ status_code: 'FAILED', last_error_code: 'TEMPLATE_NOT_SET' });
    expect(sends()).toHaveLength(0);
  });

  it('리스를 못 잡으면 아무것도 하지 않는다', async () => {
    const id = await delivery();
    const orphan = await delivery({ status_code: 'SENDING', updated_at: new Date(NOW.getTime() - 10 * 60_000) });
    const client = new ZaloClient({ apiBaseUrl: stub.url, oauthBaseUrl: stub.url });
    const blocked = new ZaloDeliveryRunner(
      true, prisma, { acquire: () => Promise.resolve(false), release: () => Promise.resolve() }, client, new ZaloTokenService(prisma, box, client),
    );
    await blocked.tick(NOW);

    expect(await row(id)).toMatchObject({ status_code: 'PENDING' });
    expect(await row(orphan)).toMatchObject({ status_code: 'SENDING' });
    expect(stub.requests).toHaveLength(0);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function sends() {
    return stub.requests.filter((r) => r.path === '/message/template');
  }

  function row(id: bigint) {
    return prisma.zalo_delivery.findUniqueOrThrow({ where: { zalo_delivery_id: id } });
  }

  async function connection(): Promise<void> {
    await prisma.zalo_connection.create({
      data: {
        zalo_connection_id: 1,
        app_id: 'APP-1',
        secret_key_enc: box.seal('secret-old'),
        refresh_token_enc: box.seal('refresh-old'),
        access_token_enc: box.seal('access-old'),
        access_token_expires_at: new Date(NOW.getTime() + 20 * HOUR),
        last_refreshed_at: new Date(NOW.getTime() - HOUR),
        status_code: 'ACTIVE',
      },
    });
  }

  async function delivery(extra: Partial<{ status_code: string; expires_at: Date; updated_at: Date }> = {}): Promise<bigint> {
    sequence += 1;
    const id = BigInt(Date.now()) * 1000n + BigInt(sequence);
    // 건마다 사건을 따로 — `uq_zalo_delivery_recipient(event, recipient)` 에 걸리지 않게.
    const event = await prisma.notification_event.create({
      data: { event_type_code: EVENT, aggregate_type_code: 'WORK_ORDER', aggregate_id: id, occurred_at: NOW },
    });
    eventIds.push(event.notification_event_id);
    await prisma.zalo_delivery.create({
      data: {
        zalo_delivery_id: id,
        notification_event_id: event.notification_event_id,
        recipient_user_id: recipientId,
        phone_number: '84912345678',
        event_type_code: EVENT,
        template_data: { wo_no: 'WO-1', event_time: '21/10/2026 10:00' },
        tracking_id: `zd-${id}`,
        next_attempt_at: NOW,
        expires_at: new Date(NOW.getTime() + 24 * HOUR),
        ...extra,
      },
    });
    return id;
  }
});
