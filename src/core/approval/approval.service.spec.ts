import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from '../document-state';
import { ApprovalService } from './approval.service';

const KIM = 11n;
const LEE = 22n;
const NAM = 33n;
const REQUEST_ID = 700n;

type Args = Record<string, unknown>;
type RouteStepSeed = { step_no: number; approver_type_code: string; approver_user_id: bigint | null };
type RouteSeed = { approval_route_id: bigint; business_unit_id: bigint | null; approval_route_step: RouteStepSeed[] };
type StepSeed = { step_no: number; approver_id: bigint; decision_code: string | null };
type Seed = { routes?: RouteSeed[]; request?: { status_code: string; version_no: number }; steps?: StepSeed[] };

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
  const writes = { created: [] as Args[], stepUpdates: [] as Args[], requestUpdates: [] as Args[] };
  const record = (into: Args[]) => async (args: Args) => (into.push(args), { count: 1 });
  const tx = {
    approval_route: { findMany: async () => seed.routes ?? [] },
    approval_route_step: { findMany: async () => seed.routes?.[0]?.approval_route_step ?? [] },
    approval_step: {
      findMany: async () => seed.steps ?? [],
      createMany: async ({ data }: { data: Args[] }) => void writes.created.push(...data),
      updateMany: record(writes.stepUpdates),
    },
    approval_request: {
      findUnique: async () => seed.request ?? null,
      updateMany: record(writes.requestUpdates),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, writes };
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
      // 결재선의 step_no 가 3·7 이어도 전개는 1·2 로 다시 매긴다.
      const { tx, writes } = fake({ routes: [route(1n, null, [by(3, KIM), by(7, LEE)])] });

      await service.expandSteps(tx, 1n, REQUEST_ID);

      expect(writes.created).toEqual([
        { approval_request_id: REQUEST_ID, step_no: 1, approver_id: KIM },
        { approval_request_id: REQUEST_ID, step_no: 2, approver_id: LEE },
      ]);
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
