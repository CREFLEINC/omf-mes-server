import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_I28_PREVIEW_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/notification-subscriptions/recipients:preview';

interface UserFixture {
  id: bigint;
  name: string;
  cookie: string;
}

function validator(status: 200 | 400 | 403): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as object;
  const pointer = `/paths/~1app~1notification-subscriptions~1recipients:preview/post/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('알림 수신자 preview (I-28 PR ③ e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actor: UserFixture;
  let otherActor: UserFixture;
  let noPermission: UserFixture;
  let inactiveActor: UserFixture;
  let activeMatched: UserFixture;
  let inactiveMatched: UserFixture;
  let otherBusinessUnit: UserFixture;
  let noDepartment: UserFixture;
  let noBusinessUnitDepartment: UserFixture;
  let alternateScopeAndWorker: UserFixture;
  let inactiveDepartmentUser: UserFixture;
  let inactiveOrganizationUser: UserFixture;
  let mutableUser: UserFixture;
  let businessUnitAId: bigint;
  let businessUnitBId: bigint;
  let inactiveBusinessUnitId: bigint;
  let departmentAId: bigint;
  let departmentBId: bigint;
  let roleAId: bigint;
  let roleBId: bigint;
  let emptyRoleId: bigint;
  let inactiveRoleId: bigint;
  let terminalCookie: string;
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];
  const departmentIds: bigint[] = [];
  const businessUnitIds: bigint[] = [];
  const legalEntityIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const workerIds: bigint[] = [];
  const idempotencyKeys: string[] = [];
  const validateSuccess = validator(200);
  const validateBadRequest = validator(400);
  const validateForbidden = validator(403);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const legalEntity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}_LE`,
        legal_entity_name: '미리보기 시험 법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    legalEntityIds.push(legalEntity.legal_entity_id);
    const units = [];
    for (const [code, isActive] of [
      ['A', true],
      ['B', true],
      ['INACTIVE', false],
    ] as const) {
      const unit = await prisma.business_unit.create({
        data: {
          legal_entity_id: legalEntity.legal_entity_id,
          business_unit_code: `${PREFIX}_BU_${code}`,
          business_unit_name: `미리보기 사업부 ${code}`,
          is_active: isActive,
        },
      });
      businessUnitIds.push(unit.business_unit_id);
      units.push(unit);
    }
    [businessUnitAId, businessUnitBId, inactiveBusinessUnitId] = units.map(
      (unit) => unit.business_unit_id,
    );
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: legalEntity.legal_entity_id,
        business_unit_id: businessUnitAId,
        plant_code: `${PREFIX}_PLANT`,
        plant_name: '미리보기 시험 공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantIds.push(plant.plant_id);

    const departments = [];
    for (const [code, businessUnitId, isActive] of [
      ['A', businessUnitAId, true],
      ['B', businessUnitBId, true],
      ['NO_BU', null, true],
      ['INACTIVE', businessUnitAId, false],
      ['INACTIVE_BU', inactiveBusinessUnitId, true],
    ] as const) {
      const department = await prisma.department.create({
        data: {
          department_code: `${PREFIX}_DEPT_${code}`,
          department_name: `실제 부서 ${code}`,
          business_unit_id: businessUnitId,
          is_active: isActive,
        },
      });
      departmentIds.push(department.department_id);
      departments.push(department);
    }
    [departmentAId, departmentBId] = departments.map((department) => department.department_id);

    const roles = [];
    for (const [code, isActive] of [
      ['PERMISSION', true],
      ['A', true],
      ['B', true],
      ['EMPTY', true],
      ['INACTIVE', false],
    ] as const) {
      const role = await prisma.role.create({
        data: {
          role_code: `${PREFIX}_ROLE_${code}`,
          role_name: `미리보기 역할 ${code}`,
          is_active: isActive,
        },
      });
      roleIds.push(role.role_id);
      roles.push(role);
    }
    const [permissionRole, roleA, roleB, emptyRole, inactiveRole] = roles;
    [roleAId, roleBId, emptyRoleId, inactiveRoleId] = [
      roleA.role_id,
      roleB.role_id,
      emptyRole.role_id,
      inactiveRole.role_id,
    ];
    await prisma.role_permission.create({
      data: { role_id: permissionRole.role_id, permission_code: 'W-CO-11' },
    });

    const jwt = app.get(JwtService);
    const createUser = async (
      name: string,
      departmentId: bigint | null,
      isActive = true,
    ): Promise<UserFixture> => {
      const row = await prisma.app_user.create({
        data: {
          login_id: `${PREFIX}_${name}`,
          user_name: `실제 사용자 ${name}`,
          department_id: departmentId,
          status_code: 'EMPLOYED',
          is_active: isActive,
        },
      });
      userIds.push(row.app_user_id);
      return {
        id: row.app_user_id,
        name: row.user_name,
        cookie: `${SESSION_COOKIE}=${jwt.sign({ sub: Number(row.app_user_id), typ: 'session' })}`,
      };
    };
    actor = await createUser('ACTOR', null);
    otherActor = await createUser('OTHER_ACTOR', null);
    noPermission = await createUser('NO_PERMISSION', null);
    inactiveActor = await createUser('INACTIVE_ACTOR', null, false);
    activeMatched = await createUser('ACTIVE_A', departmentAId);
    inactiveMatched = await createUser('INACTIVE_A', departmentAId, false);
    otherBusinessUnit = await createUser('OTHER_BU', departmentBId);
    noDepartment = await createUser('NO_DEPARTMENT', null);
    noBusinessUnitDepartment = await createUser('NO_BU_DEPARTMENT', departments[2].department_id);
    alternateScopeAndWorker = await createUser('SCOPE_WORKER', departmentBId);
    inactiveDepartmentUser = await createUser('INACTIVE_DEPT', departments[3].department_id);
    inactiveOrganizationUser = await createUser('INACTIVE_ORG', departments[4].department_id);
    mutableUser = await createUser('MUTABLE', departmentAId);
    terminalCookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(actor.id), typ: 'terminal' })}`;

    await prisma.user_role.createMany({
      data: [
        { app_user_id: actor.id, role_id: permissionRole.role_id },
        { app_user_id: otherActor.id, role_id: permissionRole.role_id },
        { app_user_id: activeMatched.id, role_id: roleAId },
        { app_user_id: activeMatched.id, role_id: roleBId },
        { app_user_id: inactiveMatched.id, role_id: roleAId },
        { app_user_id: otherBusinessUnit.id, role_id: roleAId },
        { app_user_id: noDepartment.id, role_id: roleAId },
        { app_user_id: noBusinessUnitDepartment.id, role_id: roleAId },
        { app_user_id: alternateScopeAndWorker.id, role_id: roleAId },
        { app_user_id: inactiveDepartmentUser.id, role_id: roleAId },
        { app_user_id: inactiveOrganizationUser.id, role_id: inactiveRoleId },
        { app_user_id: mutableUser.id, role_id: roleAId },
      ],
    });
    await prisma.user_data_scope.create({
      data: { app_user_id: alternateScopeAndWorker.id, business_unit_id: businessUnitAId },
    });
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}_WORKER`,
        worker_name: '접근범위와 다른 작업자',
        business_unit_id: businessUnitAId,
        plant_id: plant.plant_id,
        department_id: departmentAId,
        app_user_id: alternateScopeAndWorker.id,
        status_code: 'EMPLOYED',
      },
    });
    workerIds.push(worker.worker_id);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await cleanup();
        expect(await fixtureResidue()).toEqual({
          idempotency: 0,
          workers: 0,
          users: 0,
          roles: 0,
          departments: 0,
          businessUnits: 0,
          plants: 0,
          legalEntities: 0,
        });
      }
    } finally {
      await app?.close();
    }
  });

  it('ROLE은 app_user 부서의 사업부와 user_role이 모두 맞는 사용자만 PK 순으로 전개한다', async () => {
    const response = await preview({
      recipients: [roleRecipient(businessUnitAId, roleAId)],
    }).expect(200);
    expect(validateSuccess(response.body)).toBe(true);
    expect(validateSuccess.errors ?? []).toEqual([]);
    const expected = [activeMatched, inactiveMatched, inactiveDepartmentUser, mutableUser]
      .sort((a, b) => Number(a.id - b.id))
      .map((user) => Number(user.id));
    expect(response.body.users.map((user: { userId: number }) => user.userId)).toEqual(expected);
    expect(response.body.totalCount).toBe(3);
    expect(new Date(response.body.resolvedAt).toISOString()).toBe(response.body.resolvedAt);
  });

  it('부서 없는 USER는 직접 포함되고 부서 없는 사용자와 사업부 없는 부서 사용자는 ROLE에서 빠진다', async () => {
    const roleOnly = await preview({
      recipients: [roleRecipient(businessUnitAId, roleAId)],
    }).expect(200);
    expect(userIdsOf(roleOnly.body)).not.toContain(Number(noDepartment.id));
    expect(userIdsOf(roleOnly.body)).not.toContain(Number(noBusinessUnitDepartment.id));

    const direct = await preview({
      recipients: [userRecipient(noDepartment.id), userRecipient(noBusinessUnitDepartment.id)],
    }).expect(200);
    const withoutDepartment = direct.body.users.find(
      (user: { userId: number }) => user.userId === Number(noDepartment.id),
    );
    const withoutBusinessUnit = direct.body.users.find(
      (user: { userId: number }) => user.userId === Number(noBusinessUnitDepartment.id),
    );
    expect(withoutDepartment).toEqual({
      userId: Number(noDepartment.id),
      userName: noDepartment.name,
      isActive: true,
    });
    expect(withoutBusinessUnit).toMatchObject({
      userName: noBusinessUnitDepartment.name,
      departmentName: '실제 부서 NO_BU',
    });
  });

  it('user_data_scope와 worker의 사업부·부서를 계정 소속으로 대체하지 않는다', async () => {
    const response = await preview({
      recipients: [roleRecipient(businessUnitAId, roleAId)],
    }).expect(200);
    expect(userIdsOf(response.body)).not.toContain(Number(alternateScopeAndWorker.id));
    const direct = await preview({
      recipients: [userRecipient(alternateScopeAndWorker.id)],
    }).expect(200);
    expect(direct.body.users[0]).toMatchObject({
      userName: alternateScopeAndWorker.name,
      departmentName: '실제 부서 B',
    });
  });

  it('ROLE 두 개와 USER가 같은 사람을 가리켜도 사용자 PK로 한 번만 표시한다', async () => {
    const response = await preview({
      recipients: [
        roleRecipient(businessUnitAId, roleAId),
        roleRecipient(businessUnitAId, roleBId),
        userRecipient(activeMatched.id),
      ],
    }).expect(200);
    expect(userIdsOf(response.body).filter((id) => id === Number(activeMatched.id))).toHaveLength(1);
  });

  it('inactive 사용자는 표시하고 totalCount는 active 사용자만 센다', async () => {
    // 설계 미정 — 문의 101: 비활성 계정은 규칙을 지우지 않고 화면에 표시한다.
    const response = await preview({ recipients: [userRecipient(inactiveMatched.id)] }).expect(200);
    expect(response.body).toMatchObject({
      totalCount: 0,
      users: [
        {
          userId: Number(inactiveMatched.id),
          userName: inactiveMatched.name,
          departmentName: '실제 부서 A',
          isActive: false,
        },
      ],
    });
  });

  it('비활성 역할·사업부·부서에서 합성 활성값이나 새 차단 규칙을 만들지 않는다', async () => {
    // 설계 미정 — 문의 101: app_user.is_active 외의 활성축은 수신 여부로 도출하지 않는다.
    const response = await preview({
      recipients: [
        roleRecipient(inactiveBusinessUnitId, inactiveRoleId),
        roleRecipient(businessUnitAId, roleAId),
      ],
    }).expect(200);
    for (const user of [inactiveOrganizationUser, inactiveDepartmentUser]) {
      expect(response.body.users).toContainEqual(
        expect.objectContaining({ userId: Number(user.id), isActive: true }),
      );
    }
  });

  it('사람이 없는 유효 역할과 recipients 빈 배열은 각각 빈 성공이다', async () => {
    for (const body of [
      { recipients: [roleRecipient(businessUnitAId, emptyRoleId)] },
      { recipients: [], zaloEnabled: true },
    ]) {
      const response = await preview(body).expect(200);
      expect(validateSuccess(response.body)).toBe(true);
      expect(response.body).toMatchObject({ totalCount: 0, users: [] });
      expect(response.body).not.toHaveProperty('missingContactCount');
    }
  });

  it.each([
    [{ recipientTypeCode: 'ROLE', roleId: 1 }, 'recipients[0].businessUnitId', 'PAIR'],
    [{ recipientTypeCode: 'ROLE', businessUnitId: 1 }, 'recipients[0].roleId', 'PAIR'],
    [
      { recipientTypeCode: 'ROLE', businessUnitId: 1, roleId: 1, userId: 1 },
      'recipients[0].userId',
      'PAIR',
    ],
    [{ recipientTypeCode: 'USER' }, 'recipients[0].userId', 'PAIR'],
    [
      { recipientTypeCode: 'USER', userId: 1, businessUnitId: 1 },
      'recipients[0].businessUnitId',
      'PAIR',
    ],
    [{ recipientTypeCode: 'USER', userId: 1, roleId: 1 }, 'recipients[0].roleId', 'PAIR'],
    [{ recipientTypeCode: 'USER', userId: null }, 'recipients[0].userId', 'INVALID'],
  ])('ROLE/USER 짝 위반과 null은 정확한 field의 400이다 (%j)', async (recipient, field, code) => {
    const response = await preview({ recipients: [recipient] }).expect(400);
    expect(validateBadRequest(response.body)).toBe(true);
    expect(response.body.errors).toContainEqual(expect.objectContaining({ field, code }));
  });

  it('recipients 필수 본문 칸이 없으면 정확한 REQUIRED 400이다', async () => {
    const response = await preview({}).expect(400);
    expect(validateBadRequest(response.body)).toBe(true);
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: 'recipients', code: 'REQUIRED' }),
    );
  });

  it('중복 규칙은 뒤 행과 정확한 uniqueScope의 400이다', async () => {
    const cases: [Record<string, unknown>[], string[]][] = [
      [
        [
          roleRecipient(businessUnitAId, roleAId),
          roleRecipient(businessUnitAId, roleAId),
        ],
        ['businessUnitId', 'roleId'],
      ],
      [[userRecipient(activeMatched.id), userRecipient(activeMatched.id)], ['userId']],
    ];
    for (const [recipients, uniqueScope] of cases) {
      const response = await preview({ recipients }).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({
          field: 'recipients[1]',
          code: 'UNIQUE_VIOLATION',
          uniqueScope,
        }),
      ]);
    }
  });

  it('없는 FK는 일괄 확인 뒤 정확한 field의 INVALID다', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [roleRecipient(-9001n, roleAId), 'recipients[0].businessUnitId'],
      [roleRecipient(businessUnitAId, -9002n), 'recipients[0].roleId'],
      [userRecipient(-9003n), 'recipients[0].userId'],
    ];
    for (const [recipient, field] of cases) {
      const response = await preview({ recipients: [recipient] }).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field, code: 'INVALID' }),
      ]);
    }
  });

  it('preview는 업무표를 바꾸지 않고 완료 멱등기록 하나에 정확한 응답만 저장한다', async () => {
    const before = await businessTableCounts();
    const key = newKey();
    const response = await preview(
      { recipients: [userRecipient(activeMatched.id)], zaloEnabled: true },
      key,
    ).expect(200);
    expect(await businessTableCounts()).toEqual(before);
    expect(response.body).not.toHaveProperty('zaloEnabled');
    expect(response.body).not.toHaveProperty('missingContactCount');
    const record = await prisma.idempotency_record.findUniqueOrThrow({
      where: { idempotency_key: key },
    });
    expect(record).toMatchObject({
      app_user_id: actor.id,
      status: 'COMPLETED',
      response_status: 200,
      response_body: response.body,
    });
  });

  it('같은 키는 소속 변경 뒤에도 최초 시각·사용자를 재생하고 새 키는 다시 전개한다', async () => {
    const body = { recipients: [roleRecipient(businessUnitAId, roleAId)] };
    const key = newKey();
    const first = await preview(body, key).expect(200);
    expect(userIdsOf(first.body)).toContain(Number(mutableUser.id));
    await prisma.app_user.update({
      where: { app_user_id: mutableUser.id },
      data: { department_id: departmentBId },
    });
    const replay = await preview(body, key).expect(200);
    expect(replay.body).toEqual(first.body);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const fresh = await preview(body).expect(200);
    expect(userIdsOf(fresh.body)).not.toContain(Number(mutableUser.id));
    expect(fresh.body.resolvedAt).not.toBe(first.body.resolvedAt);
  });

  it('같은 멱등 키의 다른 actor나 body는 앞 응답을 노출하지 않고 409다', async () => {
    const key = newKey();
    const body = { recipients: [userRecipient(activeMatched.id)] };
    await preview(body, key).expect(200);
    for (const call of [
      () => preview(body, key, otherActor.cookie),
      () => preview({ ...body, zaloEnabled: true }, key),
    ]) {
      const response = await call().expect(409);
      expect(response.body).toMatchObject({ conflictCause: 'user' });
      expect(response.text).not.toContain(activeMatched.name);
    }
  });

  it('멱등 완료 저장 실패는 기록을 롤백하고 같은 키 재시도에서 다시 전개한다', async () => {
    const key = newKey();
    const body = { recipients: [userRecipient(noDepartment.id)] };
    const businessRowsBefore = await businessTableCounts();
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, 'update')
            .mockRejectedValueOnce(new Error('I28_PREVIEW_COMPLETION_FAILURE'));
          try {
            return await (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await preview(body, key).expect(500);
      expect(failed.text).not.toContain('I28_PREVIEW_COMPLETION_FAILURE');
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await prisma.idempotency_record.findUnique({ where: { idempotency_key: key } })).toBeNull();
    await prisma.app_user.update({
      where: { app_user_id: noDepartment.id },
      data: { user_name: `${noDepartment.name} 변경` },
    });
    const retried = await preview(body, key).expect(200);
    expect(retried.body.users[0].userName).toBe(`${noDepartment.name} 변경`);
    expect((await preview(body, key).expect(200)).body).toEqual(retried.body);
    expect(await businessTableCounts()).toEqual(businessRowsBefore);
  });

  it('권한 없음은 403이고 세션 없음·terminal-only·비활성 계정은 401이다', async () => {
    const body = { recipients: [] };
    const forbidden = await preview(body, undefined, noPermission.cookie).expect(403);
    expect(validateForbidden(forbidden.body)).toBe(true);
    expect(forbidden.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const cookie of [undefined, terminalCookie, inactiveActor.cookie]) {
      const call = request(app.getHttpServer()).post(PATH).set('Idempotency-Key', newKey()).send(body);
      if (cookie !== undefined) call.set('Cookie', cookie);
      const response = await call.expect(401);
      expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  it.each([
    [undefined, 'REQUIRED'],
    ['', 'REQUIRED'],
    ['not-a-uuid', 'INVALID'],
  ])('Idempotency-Key %j는 공용 %s 400이다', async (key, code) => {
    const call = request(app.getHttpServer()).post(PATH).set('Cookie', actor.cookie).send({
      recipients: [],
    });
    if (key !== undefined) call.set('Idempotency-Key', key);
    const response = await call.expect(400);
    expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code });
  });

  function preview(
    body: object,
    key: string = newKey(),
    cookie: string = actor.cookie,
  ): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body);
  }

  function newKey(): string {
    const key = randomUUID();
    idempotencyKeys.push(key);
    return key;
  }

  async function businessTableCounts(): Promise<Record<string, number>> {
    const [notifications, events, subscriptions, audit] = await Promise.all([
      prisma.notification.count(),
      prisma.notification_event.count(),
      prisma.notification_subscription.count(),
      prisma.audit_event.count(),
    ]);
    return { notifications, events, subscriptions, audit };
  }

  async function cleanup(): Promise<void> {
    await prisma.idempotency_record.deleteMany({
      where: { idempotency_key: { in: idempotencyKeys } },
    });
    await prisma.worker.deleteMany({ where: { worker_id: { in: workerIds } } });
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.department.deleteMany({ where: { department_id: { in: departmentIds } } });
    await prisma.plant.deleteMany({ where: { plant_id: { in: plantIds } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_id: { in: businessUnitIds } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_id: { in: legalEntityIds } } });
  }

  async function fixtureResidue(): Promise<Record<string, number>> {
    const [idempotency, workers, users, roles, departments, businessUnits, plants, legalEntities] =
      await Promise.all([
        prisma.idempotency_record.count({ where: { idempotency_key: { in: idempotencyKeys } } }),
        prisma.worker.count({ where: { worker_id: { in: workerIds } } }),
        prisma.app_user.count({ where: { app_user_id: { in: userIds } } }),
        prisma.role.count({ where: { role_id: { in: roleIds } } }),
        prisma.department.count({ where: { department_id: { in: departmentIds } } }),
        prisma.business_unit.count({ where: { business_unit_id: { in: businessUnitIds } } }),
        prisma.plant.count({ where: { plant_id: { in: plantIds } } }),
        prisma.legal_entity.count({ where: { legal_entity_id: { in: legalEntityIds } } }),
      ]);
    return { idempotency, workers, users, roles, departments, businessUnits, plants, legalEntities };
  }
});

function roleRecipient(businessUnitId: bigint, roleId: bigint): Record<string, unknown> {
  return {
    recipientTypeCode: 'ROLE',
    businessUnitId: Number(businessUnitId),
    roleId: Number(roleId),
  };
}

function userRecipient(userId: bigint): Record<string, unknown> {
  return { recipientTypeCode: 'USER', userId: Number(userId) };
}

function userIdsOf(body: { users: { userId: number }[] }): number[] {
  return body.users.map((user) => user.userId);
}
