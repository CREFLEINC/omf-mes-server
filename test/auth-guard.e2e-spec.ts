import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createUserWithPermissions,
  deleteUserWithPermissions,
  issueToken,
} from './support/auth.fixture';

const READER = 'E2E-GUARD-R';
const NOBODY = 'E2E-GUARD-N';

describe('전역 가드 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let readerToken: string;
  let nobodyToken: string;
  let nobodyId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token: readerToken } = await createUserWithPermissions(app, READER, ['MASTER_READ']));
    ({ token: nobodyToken, appUserId: nobodyId } = await createUserWithPermissions(app, NOBODY, []));
  });

  afterAll(async () => {
    await deleteUserWithPermissions(app, READER);
    await deleteUserWithPermissions(app, NOBODY);
    await app.close();
  });

  function warehouses(token?: string) {
    const req = request(app.getHttpServer()).get('/api/mdm/warehouses');

    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  describe('공개 엔드포인트', () => {
    it('헬스체크는 토큰 없이 200 이다 — 컨테이너가 토큰 없이 호출한다', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200);
    });

    it('로그인은 토큰 없이 부를 수 있다', async () => {
      // 자격증명이 틀려 401 이지만, 가드에 막힌 401 이 아니라 로그인 로직의 401 이다.
      const { body } = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ loginId: '없는계정', password: 'x' })
        .expect(401);

      expect(body.message).toBe('로그인할 수 없습니다.');
    });
  });

  describe('보호 엔드포인트', () => {
    it('토큰이 없으면 401 이다', async () => {
      await warehouses().expect(401);
    });

    it.each([
      ['형식이 틀린 토큰', 'not-a-jwt'],
      ['서명이 다른 토큰', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.wrong-signature'],
    ])('%s 는 401 이다', async (_label, token) => {
      await warehouses(token).expect(401);
    });

    it('권한이 있으면 200 이다', async () => {
      await warehouses(readerToken).expect(200);
    });

    it('권한이 없으면 403 이고 계약의 오류 봉투로 답한다', async () => {
      const { body } = await warehouses(nobodyToken).expect(403);

      expect(body).toEqual({
        errors: [{ scope: 'screen', code: 'PERMISSION_DENIED', message: '권한이 없습니다.' }],
      });
    });
  });

  describe('매 요청 계정 재확인', () => {
    it('토큰 발급 뒤 계정이 정지되면 그 토큰으로 401 이다', async () => {
      const { token } = await createUserWithPermissions(app, 'E2E-GUARD-S', ['MASTER_READ']);
      await warehouses(token).expect(200);

      await prisma.app_user.update({
        where: { login_id: 'E2E-GUARD-S-user' },
        data: { is_active: false },
      });

      // 토큰 자체는 아직 유효하다 — 계정 상태로 막는 것이 ADR 0002 의 요구다.
      await warehouses(token).expect(401);

      await prisma.app_user.update({
        where: { login_id: 'E2E-GUARD-S-user' },
        data: { is_active: true },
      });
      await deleteUserWithPermissions(app, 'E2E-GUARD-S');
    });

    it('권한을 회수하면 다음 요청부터 403 이다 — 토큰을 다시 받지 않아도 된다', async () => {
      const token = await issueToken(app, `${READER}-user`);
      await warehouses(token).expect(200);

      const role = await prisma.role.findUniqueOrThrow({ where: { role_code: `${READER}-ROLE` } });
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });

      await warehouses(token).expect(403);

      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: 'MASTER_READ' },
      });
    });

    it('역할을 사용 중지하면 그 권한이 사라진다', async () => {
      const role = await prisma.role.findUniqueOrThrow({ where: { role_code: `${READER}-ROLE` } });
      await prisma.role.update({ where: { role_id: role.role_id }, data: { is_active: false } });

      await warehouses(readerToken).expect(403);

      await prisma.role.update({ where: { role_id: role.role_id }, data: { is_active: true } });
      await warehouses(readerToken).expect(200);
    });
  });

  it('알 수 없는 사용자 id 를 담은 토큰은 401 이다', async () => {
    // 계정이 지워진 뒤 남은 토큰.
    const { token } = await createUserWithPermissions(app, 'E2E-GUARD-D', ['MASTER_READ']);
    await deleteUserWithPermissions(app, 'E2E-GUARD-D');

    await warehouses(token).expect(401);
    expect(nobodyId).toBeDefined();
  });
});
