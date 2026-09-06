import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { CancelEligibility, CancelEligibilityService } from './cancel-eligibility.service';
import { CancelableDocumentType, DocumentCancelService } from './document-cancel.service';

const DOC_ID = 11n;
const USER = 7;
const VERSION = 3;
const APPROVAL_NO = 'AP-20260906-0001';

type Args = Record<string, unknown>;

interface Seed {
  /** 잠근 대상 행. `undefined` 면 없는 문서다(404). */
  locked?: { status_code: string; version_no: number };
  /** `evaluate()` 가 낼 판정. 기본은 「취소 가능」. */
  verdict?: Partial<CancelEligibility>;
  /** 결재선 단계. 빈 배열이면 `selectRoute` 가 `ROUTE_NOT_FOUND` 를 던진다. */
  routeSteps?: number;
  /** 이미 열린(`PENDING`) 취소 요청. */
  openApproval?: bigint;
  /** 상태를 옮기는 조건부 UPDATE 가 짚은 행 수. */
  updated?: number;
}

/**
 * 트랜잭션 하나를 흉내낸다 — 어느 표를 어떤 `where`·`data` 로 썼는지가 이 스위트의 목이다.
 * 승인 코어(`ApprovalService`)는 «진짜»를 쓴다: 결재선 선택·중복 상신 판정이 이 경로의 400
 * 두 개(`ROUTE_NOT_FOUND`·`APPROVAL_IN_PROGRESS`)를 내는 자리라 대역으로 두면 아무것도 안 본다.
 */
function fake(seed: Seed = {}) {
  const args: Record<string, Args[]> = {};
  const rec =
    <T>(name: string, result: () => T) =>
    async (a: Args) => {
      (args[name] ??= []).push(a);
      return result();
    };
  const steps = Array.from({ length: seed.routeSteps ?? 1 }, (_, index) => ({
    approval_route_id: 1n,
    step_no: index + 1,
    approver_type_code: 'USER',
    approver_user_id: BigInt(90 + index),
  }));
  const writable = (name: string) => ({
    updateMany: rec(`${name}.updateMany`, () => ({ count: seed.updated ?? 1 })),
    update: rec(`${name}.update`, () => ({})),
  });
  const tx = {
    inbound_receipt: writable('inbound_receipt'),
    goods_receipt: writable('goods_receipt'),
    goods_issue: writable('goods_issue'),
    approval_request: {
      findFirst: rec('approval_request.findFirst', () =>
        seed.openApproval === undefined ? null : { approval_request_id: seed.openApproval },
      ),
      create: rec('approval_request.create', () => ({ approval_request_id: 501n })),
    },
    approval_route: {
      findMany: rec('approval_route.findMany', () =>
        steps.length === 0
          ? []
          : [{ approval_route_id: 1n, business_unit_id: null, approval_route_step: steps }],
      ),
    },
    approval_route_step: { findMany: rec('approval_route_step.findMany', () => steps) },
    approval_step: { createMany: rec('approval_step.createMany', () => ({ count: steps.length })) },
    // Prisma 태그드 템플릿 — 값은 안 보고 잠근 행만 돌려준다(문장은 유형마다 리터럴이다).
    $queryRaw: () => Promise.resolve(seed.locked === undefined ? [] : [seed.locked]),
  };

  const prisma = {
    $transaction: <T>(work: (client: unknown) => Promise<T>) => work(tx),
  } as unknown as PrismaService;
  const numbering = { next: jest.fn(async () => APPROVAL_NO) } as unknown as NumberingService;
  const eligibility = {
    evaluate: async (): Promise<CancelEligibility> => ({
      successorCount: 0,
      successors: [],
      cancellable: true,
      ...seed.verdict,
    }),
  } as unknown as CancelEligibilityService;
  const documentState = new DocumentStateService();
  const service = new DocumentCancelService(
    prisma,
    new ApprovalService(documentState),
    numbering,
    documentState,
    eligibility,
  );
  const at = (name: string, index = 0) => args[name]?.[index];
  return { service, args, at, numbering, documentState };
}

function blocked(code: string): Partial<CancelEligibility> {
  return { cancellable: false, cancelBlockedReasonCode: code as CancelEligibility['cancelBlockedReasonCode'] };
}

function request(
  service: DocumentCancelService,
  typeCode: CancelableDocumentType = 'GOODS_RECEIPT',
): Promise<{ approvalRequestId: number }> {
  return service.requestCancel(typeCode, DOC_ID, VERSION, '초과 입하분 오등록', USER);
}

/** 계약 `approvalTypeCode` enum 9값 — 실측으로 대조한다(지어낸 값이 없다는 것이 판정의 근거다). */
function approvalTypeEnum(): string[] {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../../../contracts/app-공통.json'), 'utf8'),
  ) as { components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> } };
  return contract.components.schemas.ApprovalRouteCreate.properties.approvalTypeCode.enum ?? [];
}

describe('DocumentCancelService', () => {
  it('요청 — 상태를 CANCEL_REQUESTED 로 옮기고 version_no 를 올린다', async () => {
    const { service, at } = fake({ locked: { status_code: 'REGISTERED', version_no: VERSION } });

    const result = await request(service);

    expect(result).toEqual({ approvalRequestId: 501 });
    expect(at('goods_receipt.updateMany')).toEqual({
      // 토큰은 «대상 문서»의 version_no 다 — 조건부 UPDATE 가 그 값으로 잠근다(§7-2).
      where: { goods_receipt_id: DOC_ID, version_no: VERSION },
      data: { status_code: 'CANCEL_REQUESTED', version_no: { increment: 1 } },
    });
  });

  it('요청 — approvalTypeCode 는 {유형}_CANCEL 이다(계약 enum 9값과 대조)', async () => {
    const declared = approvalTypeEnum();
    expect(declared).toHaveLength(9);

    for (const typeCode of ['INBOUND_RECEIPT', 'GOODS_RECEIPT', 'GOODS_ISSUE'] as const) {
      const { service, at } = fake({ locked: { status_code: 'POSTED', version_no: VERSION } });
      await request(service, typeCode);

      const data = at('approval_request.create')?.data as Args;
      expect(data.approval_type_code).toBe(`${typeCode}_CANCEL`);
      // 지어낸 값이 아니라 계약이 이름을 준 값이다.
      expect(declared).toContain(data.approval_type_code);
    }
  });

  it('요청 — targetTypeCode 는 문서 유형 그대로다(다형 축 · FK 를 안 채운다)', async () => {
    const { service, at } = fake({ locked: { status_code: 'REGISTERED', version_no: VERSION } });

    await request(service, 'GOODS_ISSUE');

    const data = at('approval_request.create')?.data as Args;
    expect(data.target_type_code).toBe('GOODS_ISSUE');
    expect(data.target_id).toBe(DOC_ID);
    // 취소 3유형에 사업부를 파생할 축이 없다 — 공통본으로 부른다(문의 022).
    expect(at('approval_route.findMany')?.where).toMatchObject({
      approval_type_code: 'GOODS_ISSUE_CANCEL',
    });
  });

  it('요청 — 대상 문서의 approval_request_id 를 덮지 않는다(I-4 의 품의 흔적을 지우지 않는다)', async () => {
    const { service, args, at } = fake({ locked: { status_code: 'POSTED', version_no: VERSION } });

    await request(service, 'GOODS_ISSUE');

    // P/O `:request-approval` 은 FK 를 채우지만 취소 품의는 안 채운다 — 채우면 업무 승인을
    // 덮어 `:post` 의 `assertApproved` 자물쇠가 무너진다(§2-5 · plan.md §5 #12).
    expect(args['goods_issue.update']).toBeUndefined();
    expect(Object.keys(at('goods_issue.updateMany')?.data as Args)).toEqual([
      'status_code',
      'version_no',
    ]);
  });

  it('요청 — 결재선이 없으면 400 ROUTE_NOT_FOUND 다', async () => {
    // 결재선을 잡지 않는다 — 코어가 던지는 400 을 그대로 흘린다(계약 「취소 결재선이 없다」).
    const { service, args } = fake({
      locked: { status_code: 'REGISTERED', version_no: VERSION },
      routeSteps: 0,
    });

    await expect(request(service)).rejects.toMatchObject({
      response: { errors: [{ code: 'ROUTE_NOT_FOUND' }] },
    });
    // 상태는 안 옮긴다 — 요청이 서지 않았는데 문서만 CANCEL_REQUESTED 로 가면 영구히 잠긴다.
    expect(args['goods_receipt.updateMany']).toBeUndefined();
  });

  it('요청 — 열린 요청이 이미 있으면 400 CANCEL_IN_PROGRESS 다(J-7)', async () => {
    const { service } = fake({
      locked: { status_code: 'REGISTERED', version_no: VERSION },
      verdict: blocked('CANCEL_IN_PROGRESS'),
      openApproval: 88n,
    });

    // ⛔ 409 가 아니다 — 409 는 If-Match 저장 충돌 전용이고 이 넷은 계약이 400 에 나란히 적었다(R-9).
    await expect(request(service)).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ code: 'CANCEL_IN_PROGRESS' }] },
    });
  });

  it('요청 — 후속이 있으면 400 SUCCESSOR_EXISTS 다', async () => {
    const { service, numbering } = fake({
      locked: { status_code: 'POSTED', version_no: VERSION },
      verdict: { ...blocked('SUCCESSOR_EXISTS'), successorCount: 2 },
    });

    await expect(request(service)).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ code: 'SUCCESSOR_EXISTS' }] },
    });
    // 번호는 트랜잭션 «밖»에서 이미 났다 — 롤백이 되돌리지 않아 결번이 남는다(I-2.md R-2).
    expect(numbering.next).toHaveBeenCalledTimes(1);
  });

  it('전이 — 반려된 요청의 문서는 CANCEL_REQUESTED 에 머문다(되돌리는 전이가 없다 · 문의 033)', async () => {
    const { documentState } = fake();

    for (const column of [
      'logistics.inbound_receipt.status_code',
      'logistics.goods_receipt.status_code',
      'logistics.goods_issue.status_code',
    ]) {
      // 되돌리는 액션 자체가 표에 없다 — 승인 9경로에 철회·취소가 0건이라 계약이 그렇게 생겼다.
      expect(() => documentState.assertTransition(column, 'document-cancel-withdraw', 'CANCEL_REQUESTED'))
        .toThrow(/상태 전이가 등록되지 않았다/);
      // 재상신도 안 열린다 — `from` 이 REGISTERED·POSTED 뿐이다.
      expect(() =>
        documentState.assertTransition(column, 'document-request-cancel', 'CANCEL_REQUESTED'),
      ).toThrow();
      expect(documentState.assertTransition(column, 'document-cancel', 'CANCEL_REQUESTED').to).toBe(
        'CANCELLED',
      );
    }
  });

  it('전이 — goods_issue 키는 다시 만들지 않고 액션만 더한다(document-post 가 살아 있다)', async () => {
    const { documentState } = fake();

    expect(documentState.assertTransition('logistics.goods_issue.status_code', 'document-post', 'REGISTERED').to)
      .toBe('POSTED');
    const actions = documentState
      .registered()
      .filter((row) => row.column === 'logistics.goods_issue.status_code')
      .map((row) => row.action);
    expect(actions).toEqual(['document-post', 'document-request-cancel', 'document-cancel']);
  });
});
