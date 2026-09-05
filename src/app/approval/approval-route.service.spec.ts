import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalRouteService, ApprovalRouteUpdateInput } from './approval-route.service';

type Args = Record<string, unknown>;

const routeRow = (id: bigint, version: number, overrides: Args = {}): Args => ({
  approval_route_id: id,
  approval_type_code: 'GOODS_ISSUE_DISPOSAL',
  business_unit_id: null,
  min_value: null,
  max_value: null,
  is_active: true,
  version_no: version,
  ...overrides,
});

/** `get()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁. */
function stub(overrides: { route?: Args | null; steps?: Args[]; requestCounts?: Record<string, number> }) {
  const prisma = {
    approval_route: {
      findUnique: async () => overrides.route ?? null,
    },
    approval_route_step: {
      count: async () => (overrides.steps ?? []).length,
    },
    approval_request: {
      // ⛔ status_code 필터를 안 보면 이 스텁은 그 필터를 지워도 초록이다(#184 리뷰) —
      // PENDING 이 아니면 0 을 줘서 실서비스가 그 조건을 빠뜨리면 테스트가 깨지게 한다.
      count: async ({ where }: { where: { approval_type_code: string; status_code: string } }) =>
        where.status_code === 'PENDING' ? overrides.requestCounts?.[where.approval_type_code] ?? 0 : 0,
    },
  };
  return prisma as unknown as PrismaService;
}

describe('ApprovalRouteService', () => {
  it('⚠ inProgressCount 는 유형 축 근사다 — 사업부 지정본과 공통본이 같은 수를 본다 (설계 미정 — 문의 018)', async () => {
    const specific = routeRow(1n, 1, { business_unit_id: 5 });
    const common = routeRow(2n, 1, { business_unit_id: null });
    const specificPrisma = stub({ route: specific, requestCounts: { GOODS_ISSUE_DISPOSAL: 3 } });
    const commonPrisma = stub({ route: common, requestCounts: { GOODS_ISSUE_DISPOSAL: 3 } });

    const a = await new ApprovalRouteService(specificPrisma).get(1);
    const b = await new ApprovalRouteService(commonPrisma).get(2);

    // 셀 연결 칸이 없어 approval_type_code 로만 센다 — 서로 다른 결재선인데 같은
    // 수를 본다. 되돌릴 자리: I-2 에서 approval_route_id 를 더할지는 문의 018.
    expect(a.route.inProgressCount).toBe(3);
    expect(b.route.inProgressCount).toBe(3);
  });

  describe('결재선 등록', () => {
    it('같은 (유형, 사업부) 로 활성본이 있으면 400 UNIQUE_VIOLATION 이다', async () => {
      const { prisma } = writeStub({
        existingActiveRoutes: [{ approval_type_code: 'GOODS_ISSUE_DISPOSAL', business_unit_id: 5 }],
      });
      const service = new ApprovalRouteService(prisma);

      const error = await thrown(() =>
        service.create({ approvalTypeCode: 'GOODS_ISSUE_DISPOSAL', businessUnitId: 5 }),
      );

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.UNIQUE_VIOLATION);
    });

    it('상한이 하한보다 작으면 400 PAIR 다(ck_approval_route_range 는 500 이라 먼저 막는다)', async () => {
      const { prisma, writes } = writeStub();
      const service = new ApprovalRouteService(prisma);

      const error = await thrown(() =>
        service.create({ approvalTypeCode: 'PURCHASE_ORDER', minValue: 500, maxValue: 100 }),
      );

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0]).toMatchObject({ field: 'maxValue', code: ERROR_CODE.PAIR });
      expect(writes.created).toBeUndefined();
    });

    it('사업부 지정본과 전 사업부 공통본은 함께 활성일 수 있다', async () => {
      // 공통본(businessUnitId=null)이 이미 활성이어도 지정본(5) 등록은 다른 축이라 막히지
      // 않는다 — «엄격 일치» 판이라 businessUnitId 가 다르면 부딪히지 않는다.
      const { prisma, writes } = writeStub({
        existingActiveRoutes: [{ approval_type_code: 'GOODS_ISSUE_DISPOSAL', business_unit_id: null }],
      });
      const service = new ApprovalRouteService(prisma);

      const result = await service.create({ approvalTypeCode: 'GOODS_ISSUE_DISPOSAL', businessUnitId: 5 });

      expect(result.route.businessUnitId).toBe(5);
      expect(writes.created).toMatchObject({ business_unit_id: 5 });
    });
  });

  describe('결재선 수정', () => {
    it('승인 유형은 본문이 받지 않는다(스키마에 칸이 없다)', async () => {
      const { prisma, writes } = writeStub({ route: routeRow(10n, 4) });
      const service = new ApprovalRouteService(prisma);

      // 본문에 approvalTypeCode 를 억지로 실어도(계약이 안 받는 칸) 서비스가 읽는 것은
      // businessUnitId·minValue·maxValue 뿐이다 — 타입이 그 셋만 허용한다.
      await service.update(10, 3, {
        businessUnitId: 5,
        approvalTypeCode: 'PURCHASE_ORDER',
      } as unknown as ApprovalRouteUpdateInput);

      expect(writes.routeUpdate).not.toHaveProperty('approval_type_code');
    });

    it('활성본을 이미 활성인 사업부로 옮기면 400 UNIQUE_VIOLATION 이다 — 자기 자신은 충돌이 아니다', async () => {
      const { prisma } = writeStub({
        route: routeRow(10n, 4),
        existingActiveRoutes: [
          { approval_route_id: 10n, approval_type_code: 'GOODS_ISSUE_DISPOSAL', business_unit_id: 5 },
          { approval_route_id: 11n, approval_type_code: 'GOODS_ISSUE_DISPOSAL', business_unit_id: 7 },
        ],
      });
      const service = new ApprovalRouteService(prisma);

      await expect(service.update(10, 3, { businessUnitId: 5 })).resolves.toBeDefined();
      const error = await thrown(() => service.update(10, 3, { businessUnitId: 7 }));
      expect(error.errors[0].code).toBe(ERROR_CODE.UNIQUE_VIOLATION);
    });

    it('보내지 않은 사업부는 비워진다(PUT 이다)', async () => {
      const { prisma, writes } = writeStub({ route: routeRow(10n, 4) });
      const service = new ApprovalRouteService(prisma);

      await service.update(10, 3, {});

      expect(writes.routeUpdate).toMatchObject({ business_unit_id: null, min_value: null, max_value: null });
    });
  });

  describe('단계 치환', () => {
    it('배열 순서가 stepNo 1..N 이 된다', async () => {
      const { prisma, writes } = writeStub({ route: routeRow(10n, 3) });
      const service = new ApprovalRouteService(prisma);

      await service.replaceSteps(10, 3, [
        { approverTypeCode: 'USER', approverUserId: 11 },
        { approverTypeCode: 'USER', approverUserId: 22 },
      ]);

      expect(writes.stepCreate).toEqual([
        {
          approval_route_id: 10,
          step_no: 1,
          approver_type_code: 'USER',
          approver_user_id: 11,
          approver_role_id: null,
          approver_department_id: null,
        },
        {
          approval_route_id: 10,
          step_no: 2,
          approver_type_code: 'USER',
          approver_user_id: 22,
          approver_role_id: null,
          approver_department_id: null,
        },
      ]);
    });

    it('1↔2 를 맞바꿔도 uq_approval_route_step 을 위반하지 않는다(한 트랜잭션)', async () => {
      const { prisma, writes } = writeStub({ route: routeRow(10n, 3) });
      const service = new ApprovalRouteService(prisma);

      await service.replaceSteps(10, 3, [
        { approverTypeCode: 'USER', approverUserId: 22 },
        { approverTypeCode: 'USER', approverUserId: 11 },
      ]);

      // 삭제가 먼저, 생성이 나중이다 — 행 단위 UPDATE 로 맞바꾸면 uq_approval_route_step
      // UNIQUE(route, step_no) 가 중간 상태를 반드시 위반한다(계약). 통째로 지우고
      // 다시 심어야 그 자리를 지난다.
      expect(writes.order).toEqual(['delete', 'create']);
      expect((writes.stepCreate ?? []).map((s) => s.approver_user_id)).toEqual([22, 11]);
    });

    it('빈 배열은 가드가 400 RANGE 로 막는다(서비스까지 오지 않는다)', async () => {
      // 이 서비스는 빈 배열을 스스로 재검사하지 않는다 — 계약 가드(minItems→RANGE)가
      // 이미 막아 서비스까지 오지 않는다(I-1.md §7 PR②). 서비스만 단독으로 부르면
      // 통과함을 보여 「서비스의 일이 아니다」를 문서화한다.
      const { prisma, writes } = writeStub({ route: routeRow(10n, 3) });
      const service = new ApprovalRouteService(prisma);

      const result = await service.replaceSteps(10, 3, []);

      expect(result.items).toEqual([]);
      expect(writes.order).toEqual(['delete']);
    });

    it('USER 단계에 역할·부서 id 가 함께 와도 담지 않는다(ck_approval_route_step_target)', async () => {
      const { prisma, writes } = writeStub({ route: routeRow(10n, 3) });
      const service = new ApprovalRouteService(prisma);

      await service.replaceSteps(10, 3, [
        { approverTypeCode: 'USER', approverUserId: 11, approverRoleId: 7, approverDepartmentId: 3 },
      ]);

      expect(writes.stepCreate?.[0]).toMatchObject({
        approver_user_id: 11,
        approver_role_id: null,
        approver_department_id: null,
      });
    });

    it('approverTypeCode 가 ROLE 이면 400 APPROVER_TYPE_NOT_SUPPORTED 다', async () => {
      const { prisma } = writeStub({});
      const service = new ApprovalRouteService(prisma);

      const error = await thrown(() =>
        service.replaceSteps(10, 3, [{ approverTypeCode: 'ROLE', approverRoleId: 7 }]),
      );

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.APPROVER_TYPE_NOT_SUPPORTED);
    });

    it('USER 인데 approverUserId 가 없으면 400 이다', async () => {
      const { prisma } = writeStub({});
      const service = new ApprovalRouteService(prisma);

      const error = await thrown(() => service.replaceSteps(10, 3, [{ approverTypeCode: 'USER' }]));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.REQUIRED);
    });
  });
});

/**
 * 쓰기 3건(등록·수정·단계 치환)이 필요로 하는 만큼의 prisma 스텁 — 실제 필터를
 * 흉내내지 않고 테스트가 필요한 답만 준다(선례: `core/approval/approval.service.spec.ts`
 * 의 `fake()`).
 */
function writeStub(
  overrides: {
    existingActiveRoutes?: {
      approval_route_id?: bigint;
      approval_type_code: string;
      business_unit_id: number | null;
    }[];
    route?: Args | null;
    updateCount?: number;
    steps?: Args[];
  } = {},
) {
  const writes: { created?: Args; routeUpdate?: Args; order: string[]; stepCreate?: Args[] } = {
    order: [],
  };
  const prisma = {
    approval_route: {
      // ⛔ selectRoute(코어)의 OR 선택과 다르다 — 여기는 businessUnitId 축의 «엄격 일치»
      // 판이다(I-1.md §3-5). 지정본(5) 질의는 공통본(null) 행에 걸리지 않는다.
      findFirst: async ({
        where,
      }: {
        where: {
          approval_type_code: string;
          business_unit_id: number | null;
          NOT?: { approval_route_id: number };
        };
      }) =>
        (overrides.existingActiveRoutes ?? []).find(
          (r) =>
            r.approval_type_code === where.approval_type_code &&
            r.business_unit_id === where.business_unit_id &&
            (where.NOT === undefined || Number(r.approval_route_id) !== where.NOT.approval_route_id),
        ) ?? null,
      findUnique: async () => overrides.route ?? null,
      create: async ({ data }: { data: Args }) => {
        writes.created = data;
        return {
          approval_route_id: 99n,
          min_value: null,
          max_value: null,
          is_active: true,
          version_no: 1,
          ...data,
        };
      },
      updateMany: async ({ data }: { data: Args }) => {
        writes.routeUpdate = data;
        return { count: overrides.updateCount ?? 1 };
      },
    },
    approval_route_step: {
      findMany: async () => overrides.steps ?? [],
      count: async () => (overrides.steps ?? []).length,
      deleteMany: async () => {
        writes.order.push('delete');
        return { count: 0 };
      },
      createMany: async ({ data }: { data: Args[] }) => {
        writes.order.push('create');
        writes.stepCreate = data;
        return { count: data.length };
      },
    },
    // update() 는 저장 뒤 get() 으로 다시 읽는다 — 그 경로가 필요로 하는 만큼만 답한다.
    approval_request: { count: async () => 0 },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  return { prisma: prisma as unknown as PrismaService, writes };
}

/** 던진 `ContractException` 을 집어 온다 — 상태와 코드를 둘 다 봐야 하기 때문이다. */
const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );
