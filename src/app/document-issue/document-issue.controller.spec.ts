import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";

import { attachSession } from "../../auth/session-resolver.service";
import type { Session } from "../../auth/session.types";
import { DocumentIssueTargetPathChanged } from "./document-issue-sequence";
import { DocumentIssueController } from "./document-issue.controller";

describe("발행 POST 컨트롤러 배선 (I-27 C3c)", () => {
  it("201 context와 같은 tx를 writer에 전달한다", async () => {
    const setup = controller();

    await expect(setup.controller.create(request(), body())).resolves.toEqual(
      setup.response,
    );

    expect(setup.idempotency.run).toHaveBeenCalledWith(
      expect.objectContaining({
        appUserId: 17,
        terminalId: null,
        successStatus: 201,
      }),
      expect.any(Function),
    );
    expect(setup.writes.issueWithin).toHaveBeenCalledWith(
      setup.tx,
      body(),
      expect.objectContaining({ appUserId: 17, successStatus: 201 }),
    );
  });

  it("경로 변경은 멱등 run 바깥에서 tx 전체를 다시 시작한다", async () => {
    const setup = controller({ firstPathChange: true });

    await expect(setup.controller.create(request(), body())).resolves.toEqual(
      setup.response,
    );

    expect(setup.idempotency.run).toHaveBeenCalledTimes(2);
    expect(setup.writes.issueWithin).toHaveBeenCalledTimes(1);
  });

  it("저장 응답 replay는 writer를 다시 호출하지 않는다", async () => {
    const setup = controller({ replay: true });

    await expect(setup.controller.create(request(), body())).resolves.toEqual(
      setup.response,
    );

    expect(setup.writes.issueWithin).not.toHaveBeenCalled();
  });
});

interface SetupOptions {
  firstPathChange?: boolean;
  replay?: boolean;
}

function controller(options: SetupOptions = {}) {
  const tx = { name: "tx" };
  const response = { items: [], issuedCount: 1 };
  const writes = {
    issueWithin: jest.fn(async () => response),
  };
  let attempts = 0;
  const idempotency = {
    run: jest.fn(async (_context, work) => {
      attempts += 1;
      if (options.firstPathChange && attempts === 1)
        throw new DocumentIssueTargetPathChanged();
      return {
        replayed: options.replay === true,
        status: 201,
        body: options.replay ? response : await work(tx),
      };
    }),
  };
  const instance = new DocumentIssueController(
    {} as never,
    {} as never,
    {} as never,
    writes as never,
    idempotency as never,
    new JwtService({ secret: "document-controller-secret-32-characters" }),
    {} as never,
  );
  return { controller: instance, idempotency, writes, tx, response };
}

function request(): Request {
  const value = {
    method: "POST",
    path: "/api/app/document-issues",
    body: body(),
    query: {},
    headers: { "idempotency-key": "idem-1" },
  } as unknown as Request;
  attachSession(value, { userId: 17 } as Session);
  return value;
}

function body() {
  return {
    documentTypeCode: "LOCATION_LABEL" as const,
    targets: [{ targetTypeCode: "LOCATION" as const, targetId: 10 }],
  };
}
