import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";

import { attachSession, TOKEN_TYPE } from "../../auth/session-resolver.service";
import type { Session } from "../../auth/session.types";
import { PrismaService } from "../../prisma/prisma.service";
import { documentIssueWriteContext } from "./document-issue-write-context";

const jwt = new JwtService({
  secret: "document-write-context-secret-32-characters",
});

describe("발행 등록 context (I-27 C3a)", () => {
  it("관리웹 계정은 사번과 단말 없이 201 context를 만든다", async () => {
    await expect(context(createRequest())).resolves.toMatchObject({
      key: "idem-1",
      appUserId: 17,
      workerNo: undefined,
      terminalId: null,
      successStatus: 201,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("검증된 단말이 함께 온 요청은 사번을 필수로 한다", async () => {
    await expect(
      context(createRequest({ terminalToken: token(77), workerNo: undefined })),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        expect.objectContaining({ field: "X-Worker-No", code: "REQUIRED" }),
      ],
    });
  });

  it("사번 원문과 bigint 단말 문자열을 지문에 보존한다", async () => {
    const terminalId = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const result = await documentIssueWriteContext(
      createRequest({ terminalToken: token(77), workerNo: " W-017 " }),
      jwt,
      prismaOf(terminalId),
    );
    expect(result).toMatchObject({
      workerNo: " W-017 ",
      terminalId,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("계정·사번·단말·method/path/query/body가 바뀌면 지문도 달라진다", async () => {
    const baseline = await context(createRequest({ workerNo: "W-017" }));
    for (const request of [
      createRequest({ userId: 18, workerNo: "W-017" }),
      createRequest({ workerNo: "W-018" }),
      createRequest({ terminalToken: token(77), workerNo: "W-017" }),
      createRequest({ method: "PUT", workerNo: "W-017" }),
      createRequest({
        path: "/api/app/document-issues/other",
        workerNo: "W-017",
      }),
      createRequest({ query: { source: "retry" }, workerNo: "W-017" }),
      createRequest({
        body: { documentTypeCode: "PACKING_LABEL" },
        workerNo: "W-017",
      }),
    ]) {
      expect((await context(request)).fingerprint).not.toBe(
        baseline.fingerprint,
      );
    }
  });

  it("긴 사번과 배열 사번을 거절한다", async () => {
    await expect(
      context(createRequest({ workerNo: "W".repeat(51) })),
    ).rejects.toMatchObject({
      status: 400,
      errors: [expect.objectContaining({ code: "RANGE" })],
    });
    await expect(
      context(createRequest({ workerNo: ["W-1"] })),
    ).rejects.toMatchObject({
      status: 400,
      errors: [expect.objectContaining({ code: "REQUIRED" })],
    });
  });

  it("세션이 없으면 401이고 온 단말 토큰이 틀리면 400이다", async () => {
    await expect(
      context(createRequest({ attach: false })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      context(
        createRequest({
          terminalToken: jwt.sign({ sub: 77, typ: "session" }),
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        expect.objectContaining({ field: "Authorization", code: "INVALID" }),
      ],
    });
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  method?: string;
  path?: string;
  query?: object;
  terminalToken?: string;
  userId?: number;
  workerNo?: string | string[];
}

function createRequest(options: RequestOptions = {}): Request {
  const request = {
    body: options.body ?? { documentTypeCode: "LOCATION_LABEL", targets: [] },
    method: options.method ?? "POST",
    path: options.path ?? "/api/app/document-issues",
    query: options.query ?? {},
    headers: {
      "idempotency-key": "idem-1",
      "x-worker-no": options.workerNo,
      authorization: options.terminalToken
        ? `Bearer ${options.terminalToken}`
        : undefined,
    },
  } as unknown as Request;
  if (options.attach !== false)
    attachSession(request, { userId: options.userId ?? 17 } as Session);
  return request;
}

function context(request: Request) {
  return documentIssueWriteContext(request, jwt, prismaOf(77n));
}

function token(id: number): string {
  return jwt.sign({ sub: id, typ: TOKEN_TYPE.TERMINAL, tv: 3 });
}

function prismaOf(terminalId: bigint): PrismaService {
  return {
    terminal: {
      findUnique: async () => ({
        terminal_id: terminalId,
        is_active: true,
        token_version: 3,
      }),
    },
  } as unknown as PrismaService;
}
