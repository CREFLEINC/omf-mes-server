import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from '../document-state';
import { ApprovalRequestInput, ApprovalService } from './approval.service';

const KIM = 11n;
const LEE = 22n;
const NAM = 33n;
const REQUEST_ID = 700n;

type Args = Record<string, unknown>;
type RouteStepSeed = { step_no: number; approver_type_code: string; approver_user_id: bigint | null };
type RouteSeed = { approval_route_id: bigint; business_unit_id: bigint | null; approval_route_step: RouteStepSeed[] };
type StepSeed = { step_no: number; approver_id: bigint; decision_code: string | null };
type RequestSeed = {
  target_type_code: string;
  target_id: bigint;
  approval_type_code: string;
  status_code: string;
};
type Seed = {
  routes?: RouteSeed[];
  request?: { status_code: string; version_no: number };
  steps?: StepSeed[];
  requests?: RequestSeed[];
};

const by = (step_no: number, approver_user_id: bigint): RouteStepSeed => ({
  step_no,
  approver_type_code: 'USER',
  approver_user_id,
});
const route = (id: bigint, bu: bigint | null, steps: RouteStepSeed[]): RouteSeed => ({
  approval_route_id: id,
  business_unit_id: bu,
  approval_route_step: steps,
});
const pending = (step_no: number, approver_id: bigint): StepSeed => ({
  step_no,
  approver_id,
  decision_code: null,
});

function fake(seed: Seed) {
  const writes = {
    created: [] as Args[],
    stepUpdates: [] as Args[],
    requestUpdates: [] as Args[],
    requestCreates: [] as Args[],
  };
  const record = (into: Args[]) => async (args: Args) => (into.push(args), { count: 1 });
  const rows = [...(seed.requests ?? [])];
  // 어떤 표를 만졌는지 센다 — 「대상 문서를 안 건드린다」는 목이 아니라 이 집합으로 본다.
  const touched = new Set<string>();
  const models = {
    approval_route: { findMany: async () => seed.routes ?? [] },
    approval_route_step: {
      // ⚠ `orderBy` 가 왔을 때만 정렬한다(#183 재리뷰 Nit) — 실서비스가 `orderBy:
      // {step_no:'asc'}` 를 정말로 거는지를 시험한다. 그 인자를 빼먹으면 시드 순서
      // (아래서 7·3 역순) 그대로 나와 「단계 전개」 시험이 깨진다.
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { approval_route_id: bigint };
        orderBy?: { step_no: 'asc' | 'desc' };
      }) => {
        const steps =
          seed.routes?.find((r) => r.approval_route_id === where.approval_route_id)?.approval_route_step ?? [];
        if (!orderBy) return steps;
        const sign = orderBy.step_no === 'desc' ? -1 : 1;
        return [...steps].sort((a, b) => sign * (a.step_no - b.step_no));
      },
    },
    approval_step: {
      findMany: async () => seed.steps ?? [],
      createMany: async ({ data }: { data: Args[] }) => void writes.created.push(...data),
      updateMany: record(writes.stepUpdates),
    },
    approval_request: {
      findUnique: async () => seed.request ?? null,
      findFirst: async ({ where }: { where: RequestSeed }) =>
        rows.find(
          (row) =>
            row.target_type_code === where.target_type_code &&
            row.target_id === where.target_id &&
            row.approval_type_code === where.approval_type_code &&
            row.status_code === where.status_code,
        ) ?? null,
      // 만든 행이 곧바로 조회에 보인다 — 같은 트랜잭션의 둘째 상신을 시험할 수 있다.
      create: async ({ data }: { data: Args }) => {
        writes.requestCreates.push(data);
        rows.push(data as unknown as RequestSeed);
        return { approval_request_id: REQUEST_ID + BigInt(writes.requestCreates.length) };
      },
      findMany: async ({ where }: { where: Omit<RequestSeed, 'status_code'> }) =>
        rows.filter(
          (row) =>
            row.target_type_code === where.target_type_code &&
            row.target_id === where.target_id &&
            row.approval_type_code === where.approval_type_code,
        ),
      updateMany: record(writes.requestUpdates),
    },
  };
  const tx = new Proxy(models, {
    get: (target: Args, prop: string | symbol) => (touched.add(String(prop)), target[String(prop)]),
  }) as unknown as Prisma.TransactionClient;
  return { tx, writes, touched };
}

/** 던진 `ContractException` 을 집어 온다 — 상태와 코드를 둘 다 봐야 하기 때문이다. */
const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

describe('ApprovalService', () => {
  const service = new ApprovalService(new DocumentStateService());
  const twoSteps: Seed = {
    request: { status_code: 'PENDING', version_no: 3 },
    steps: [pending(1, KIM), pending(2, LEE)],
  };

  describe('결재선 선택', () => {
    it('사업부 지정본이 전 사업부 공통본을 이긴다', async () => {
      const { tx } = fake({ routes: [route(1n, null, [by(1, KIM)]), route(2n, 5n, [by(1, LEE)])] });

      await expect(service.selectRoute(tx, 'GOODS_ISSUE_DISPOSAL', 5n)).resolves.toMatchObject({
        approvalRouteId: 2n,
      });
    });

    it('지정본이 없으면 공통본이 선다', async () => {
      const { tx } = fake({ routes: [route(1n, null, [by(1, KIM)])] });

      await expect(service.selectRoute(tx, 'GOODS_ISSUE_DISPOSAL', 5n)).resolves.toMatchObject({
        approvalRouteId: 1n,
        steps: [{ stepNo: 1, approverTypeCode: 'USER', approverUserId: KIM }],
      });
    });

    it('같은 층에 둘이면 400 ROUTE_AMBIGUOUS 다(서버가 임의로 고르지 않는다)', async () => {
      const { tx } = fake({ routes: [route(1n, null, [by(1, KIM)]), route(2n, null, [by(1, LEE)])] });

      const error = await thrown(() => service.selectRoute(tx, 'PURCHASE_ORDER', null));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.ROUTE_AMBIGUOUS);
    });

    it('활성 결재선이 없으면 400 ROUTE_NOT_FOUND 다', async () => {
      const { tx } = fake({ routes: [] });

      const error = await thrown(() => service.selectRoute(tx, 'IQC_SKIP', null));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.ROUTE_NOT_FOUND);
    });

    it('단계가 0개면 ROUTE_NOT_FOUND 다', async () => {
      const { tx } = fake({ routes: [route(1n, null, [])] });

      const error = await thrown(() => service.selectRoute(tx, 'IQC_SKIP', null));

      expect(error.errors[0].code).toBe(ERROR_CODE.ROUTE_NOT_FOUND);
    });
  });

  describe('단계 전개', () => {
    it('결재선 단계가 step_no 1..N 의 approval_step 이 된다', async () => {
      // 결재선의 step_no 가 3·7 이어도 전개는 1·2 로 다시 매긴다. 시드를 역순(7·3)으로
      // 넣어 — 위 findMany 목의 orderBy 시뮬레이션과 함께 「DB 정렬을 믿는다」를 고정한다
      // (#183 재리뷰 Nit). 서비스가 orderBy 를 빼먹으면 이 시드 순서 그대로 나와 깨진다.
      const { tx, writes } = fake({ routes: [route(1n, null, [by(7, LEE), by(3, KIM)])] });

      await service.expandSteps(tx, 1n, REQUEST_ID);

      expect(writes.created).toEqual([
        { approval_request_id: REQUEST_ID, step_no: 1, approver_id: KIM },
        { approval_request_id: REQUEST_ID, step_no: 2, approver_id: LEE },
      ]);
    });

    it('단계가 0개인 결재선은 400 ROUTE_NOT_FOUND 다(빈 요청을 만들지 않는다)', async () => {
      const { tx, writes } = fake({ routes: [route(1n, null, [])] });

      const error = await thrown(() => service.expandSteps(tx, 1n, REQUEST_ID));

      expect(error.errors[0].code).toBe(ERROR_CODE.ROUTE_NOT_FOUND);
      expect(writes.created).toEqual([]);
    });

    it('USER 가 아닌 결재자 유형은 400 APPROVER_TYPE_NOT_SUPPORTED 다', async () => {
      const role: RouteStepSeed = { step_no: 1, approver_type_code: 'ROLE', approver_user_id: null };
      const { tx } = fake({ routes: [route(1n, null, [role])] });

      const error = await thrown(() => service.expandSteps(tx, 1n, REQUEST_ID));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.APPROVER_TYPE_NOT_SUPPORTED);
    });
  });

  describe('상신', () => {
    const twoStepRoute = [route(1n, null, [by(1, KIM), by(2, LEE)])];
    const input = (over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput => ({
      approvalRequestNo: 'AP-20260906-0001',
      approvalTypeCode: 'PURCHASE_ORDER',
      targetTypeCode: 'PURCHASE_ORDER',
      targetId: 900n,
      businessUnitId: null,
      requestedBy: KIM,
      reason: '자재 발주 승인 요청',
      ...over,
    });
    const open = (status_code: string, approval_type_code = 'PURCHASE_ORDER'): RequestSeed => ({
      target_type_code: 'PURCHASE_ORDER',
      target_id: 900n,
      approval_type_code,
      status_code,
    });

    it('요청·단계가 한 트랜잭션에서 선다(step_no 1..N)', async () => {
      const { tx, writes } = fake({ routes: twoStepRoute });

      const { approvalRequestId } = await service.request(tx, input());

      expect(writes.requestCreates[0]).toMatchObject({
        approval_type_code: 'PURCHASE_ORDER',
        target_id: 900n,
        status_code: 'PENDING',
      });
      expect(writes.created).toEqual([
        { approval_request_id: approvalRequestId, step_no: 1, approver_id: KIM },
        { approval_request_id: approvalRequestId, step_no: 2, approver_id: LEE },
      ]);
    });

    it('결재선이 없으면 400 ROUTE_NOT_FOUND 다(요청 행이 남지 않는다)', async () => {
      const { tx, writes } = fake({ routes: [] });

      const error = await thrown(() => service.request(tx, input()));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.ROUTE_NOT_FOUND);
      expect(writes.requestCreates).toEqual([]);
    });

    it('진행 중(PENDING) 요청이 있으면 400 APPROVAL_IN_PROGRESS 다', async () => {
      const { tx, writes } = fake({ routes: twoStepRoute, requests: [open('PENDING')] });

      const error = await thrown(() => service.request(tx, input()));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.APPROVAL_IN_PROGRESS);
      expect(writes.requestCreates).toEqual([]);
    });

    it('반려(REJECTED)된 요청은 진행 중이 아니다(새 요청이 선다)', async () => {
      const { tx, writes } = fake({ routes: twoStepRoute, requests: [open('REJECTED')] });

      await service.request(tx, input());

      expect(writes.requestCreates).toHaveLength(1);
    });

    it('승인(APPROVED)된 요청도 막지 않는다(계약이 막지 않았다)', async () => {
      const { tx, writes } = fake({ routes: twoStepRoute, requests: [open('APPROVED')] });

      await service.request(tx, input());

      expect(writes.requestCreates).toHaveLength(1);
    });

    it('같은 대상이라도 승인 유형이 다르면 막지 않는다(goods_issue 두 유형)', async () => {
      const disposal: RequestSeed = {
        target_type_code: 'GOODS_ISSUE',
        target_id: 900n,
        approval_type_code: 'GOODS_ISSUE_DISPOSAL',
        status_code: 'PENDING',
      };
      const { tx, writes } = fake({ routes: twoStepRoute, requests: [disposal] });

      await service.request(
        tx,
        input({ targetTypeCode: 'GOODS_ISSUE', approvalTypeCode: 'GOODS_ISSUE_CANCEL' }),
      );

      expect(writes.requestCreates).toHaveLength(1);
    });

    it('approval_request_no 는 인자로 받은 값 그대로다(코어가 채번을 부르지 않는다)', async () => {
      const { tx, writes } = fake({ routes: twoStepRoute });

      await service.request(tx, input({ approvalRequestNo: 'AP-20260906-0042' }));

      expect(writes.requestCreates[0]).toMatchObject({ approval_request_no: 'AP-20260906-0042' });
    });

    it('대상 문서의 어떤 행도 건드리지 않는다(approval_request_id 는 호출자 몫)', async () => {
      const { tx, touched } = fake({ routes: twoStepRoute });

      await service.request(tx, input());

      expect([...touched].sort()).toEqual([
        'approval_request',
        'approval_route',
        'approval_route_step',
        'approval_step',
      ]);
    });

    it('대상 행 잠금은 호출자 몫이다(코어의 조회만으로는 같은 순간의 둘이 다 통과한다)', async () => {
      // 서로의 INSERT 를 보기 «전»에 둘 다 조회를 마치는 자리를 그대로 재현한다.
      const { tx, writes } = fake({ routes: twoStepRoute });

      await Promise.all([service.request(tx, input()), service.request(tx, input())]);

      // 둘 다 선다 — 막는 것은 호출자가 트랜잭션 첫 문장에서 거는 대상 행 잠금이다(I-2.md R-4).
      expect(writes.requestCreates).toHaveLength(2);
    });
  });

  describe('승인 완료 판정', () => {
    const ISSUE_ID = 4100n;
    const seen = (status_code: string, approval_type_code = 'GOODS_ISSUE_DISPOSAL'): RequestSeed => ({
      target_type_code: 'GOODS_ISSUE',
      target_id: ISSUE_ID,
      approval_type_code,
      status_code,
    });
    const assert = (tx: Prisma.TransactionClient, approvalTypeCode = 'GOODS_ISSUE_DISPOSAL') =>
      service.assertApproved(tx, 'GOODS_ISSUE', ISSUE_ID, approvalTypeCode);

    it('assertApproved — 그 축에 요청이 0건이면 통과한다(승인을 타지 않은 출고)', async () => {
      // 계약 `GoodsIssue.approvalRequestId` 「비어 있으면 승인을 타지 않은 출고다」.
      const { tx } = fake({ requests: [] });

      await expect(assert(tx)).resolves.toBeUndefined();
    });

    it('assertApproved — APPROVED 가 있으면 통과한다', async () => {
      // 「승인된 뒤 재상신 → 반려」도 통과한다 — 시각 순서를 안 본다(I-4.md §8-1 ⓔ).
      const { tx } = fake({ requests: [seen('APPROVED'), seen('REJECTED')] });

      await expect(assert(tx)).resolves.toBeUndefined();
    });

    it('assertApproved — PENDING 만 있으면 400 APPROVAL_IN_PROGRESS 다', async () => {
      // 반려가 섞여 있어도 `PENDING` 이 이긴다 — 「기다려라」다.
      const { tx } = fake({ requests: [seen('REJECTED'), seen('PENDING')] });

      const error = await thrown(() => assert(tx));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.APPROVAL_IN_PROGRESS);
    });

    it('assertApproved — REJECTED 만 있으면 400 APPROVAL_REQUIRED 다', async () => {
      const { tx } = fake({ requests: [seen('REJECTED')] });

      const error = await thrown(() => assert(tx));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.APPROVAL_REQUIRED);
    });

    it('assertApproved — approvalTypeCode 가 다르면 못 본다(GOODS_ISSUE_CANCEL 승인이 업무 승인을 대신하지 않는다)', async () => {
      const { tx } = fake({ requests: [seen('APPROVED', 'GOODS_ISSUE_CANCEL'), seen('REJECTED')] });

      const error = await thrown(() => assert(tx));

      expect(error.errors[0].code).toBe(ERROR_CODE.APPROVAL_REQUIRED);
      // 뒤집으면 취소 축은 그 승인을 본다 — 축이 갈려 있다는 것이 요지다.
      await expect(assert(tx, 'GOODS_ISSUE_CANCEL')).resolves.toBeUndefined();
    });

    it('assertApproved — 대상 표의 approval_request_id 를 읽지 않는다(다형 축만 본다)', async () => {
      const { tx, touched } = fake({ requests: [seen('APPROVED')] });

      await assert(tx);

      // 목에 `goods_issue` 가 아예 없다 — FK 를 읽으려 들면 undefined 접근으로 터진다.
      expect([...touched]).toEqual(['approval_request']);
    });
  });

  describe('현재 단계', () => {
    it('첫 미결 단계 하나를 준다(전건 결재면 null)', () => {
      const done = { stepNo: 1, approverId: KIM, decisionCode: 'APPROVED' };
      const open = { stepNo: 2, approverId: LEE, decisionCode: null };

      expect(service.currentStep([open, done])).toBe(open);
      expect(service.currentStep([done])).toBeNull();
    });
  });

  describe('순차 결재', () => {
    it('앞 단계가 미결이면 400 NOT_YOUR_TURN 이다', async () => {
      const { tx } = fake(twoSteps);

      const error = await thrown(() => service.approve(tx, REQUEST_ID, 3, LEE));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.NOT_YOUR_TURN);
    });

    it('결재선에 없는 사용자는 403 이다(NOT_YOUR_TURN 이 아니다)', async () => {
      const { tx } = fake(twoSteps);

      const error = await thrown(() => service.approve(tx, REQUEST_ID, 3, NAM));

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.errors[0].code).toBe(ERROR_CODE.PERMISSION_DENIED);
    });

    it('마지막 단계 승인에서만 요청이 APPROVED 로 간다', async () => {
      const first = fake(twoSteps);
      const last = fake({
        request: { status_code: 'PENDING', version_no: 4 },
        steps: [{ ...pending(1, KIM), decision_code: 'APPROVED' }, pending(2, LEE)],
      });

      const middle = await service.approve(first.tx, REQUEST_ID, 3, KIM);
      const final = await service.approve(last.tx, REQUEST_ID, 4, LEE);

      expect(middle).toMatchObject({ statusCode: 'PENDING', versionNo: 4 });
      expect(first.writes.requestUpdates[0].data).not.toHaveProperty('status_code');
      expect(final).toMatchObject({ statusCode: 'APPROVED', versionNo: 5 });
      expect(last.writes.requestUpdates[0]).toMatchObject({ data: { status_code: 'APPROVED' } });
      // decided_at/by 는 비운다 — 계약이 안 받는 칸(I-1.md §2-3).
      expect(last.writes.requestUpdates[0].data).not.toHaveProperty('decided_at');
    });

    it('반려 — 마지막 단계가 아니어도 한 단계 반려로 요청이 REJECTED 가 된다(J-6)', async () => {
      const { tx, writes } = fake(twoSteps);

      const result = await service.reject(tx, REQUEST_ID, 3, KIM, '수량 근거 없음');

      expect(result).toMatchObject({ statusCode: 'REJECTED', versionNo: 4 });
      expect(writes.stepUpdates[0]).toMatchObject({
        where: { step_no: 1 },
        data: { decision_code: 'REJECTED', decision_comment: '수량 근거 없음' },
      });
      expect(writes.requestUpdates[0]).toMatchObject({ data: { status_code: 'REJECTED' } });
    });
  });

  describe('전이', () => {
    it('등록되지 않은 (칸, 액션) 은 던진다(F-6)', async () => {
      const bare = new ApprovalService(new DocumentStateService({}));
      const { tx } = fake(twoSteps);

      await expect(bare.approve(tx, REQUEST_ID, 3, KIM)).rejects.toThrow(
        /상태 전이가 등록되지 않았다/,
      );
    });

    it('APPROVED 인 요청에 다시 승인하면 400 STATE_LOCKED 다', async () => {
      const { tx } = fake({ request: { status_code: 'APPROVED', version_no: 5 } });

      const error = await thrown(() => service.approve(tx, REQUEST_ID, 5, KIM));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.errors[0].code).toBe(ERROR_CODE.STATE_LOCKED);
    });
  });
});
