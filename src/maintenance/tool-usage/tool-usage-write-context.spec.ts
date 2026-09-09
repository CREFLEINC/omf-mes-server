import { UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { attachSession } from "../../auth/session-resolver.service";
import type { Session } from "../../auth/session.types";
import { toolUsageWriteContext } from "./tool-usage-write-context";

describe("tool usage write context", () => {
  it("세션 주체와 원문 사번을 201 멱등 지문에 담는다", () => {
    expect(toolUsageWriteContext(createRequest())).toMatchObject({
      key: "idem-1",
      appUserId: 17,
      workerNo: "W-017",
      successStatus: 201,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("세션·원문 사번·본문·오퍼레이션이 달라지면 지문도 달라진다", () => {
    const baseline = toolUsageWriteContext(createRequest()).fingerprint;
    for (const changed of [
      createRequest({ userId: 18 }),
      createRequest({ workerNo: "W-018" }),
      createRequest({ body: { moldId: 8 } }),
      createRequest({ path: "/maintenance/other" }),
    ]) {
      expect(toolUsageWriteContext(changed).fingerprint).not.toBe(baseline);
    }
  });

  it.each([
    [undefined, "REQUIRED"],
    ["", "REQUIRED"],
    ["   ", "REQUIRED"],
    ["W".repeat(51), "RANGE"],
  ])("작업자 사번 %p를 %s로 거부한다", (workerNo, code) => {
    expect(() => toolUsageWriteContext(createRequest({ workerNo }))).toThrow(
      expect.objectContaining({
        errors: [expect.objectContaining({ field: "X-Worker-No", code })],
      }),
    );
  });

  it("50자 사번을 정규화하지 않고 보존한다", () => {
    const workerNo = ` ${"W".repeat(48)} `;
    expect(toolUsageWriteContext(createRequest({ workerNo })).workerNo).toBe(
      workerNo,
    );
  });

  it("세션이 없으면 401이다", () => {
    expect(() =>
      toolUsageWriteContext(createRequest({ attach: false })),
    ).toThrow(UnauthorizedException);
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  path?: string;
  userId?: number;
  workerNo?: string;
}

function createRequest(options: RequestOptions = {}): Request {
  const headers: Record<string, string> = { "idempotency-key": "idem-1" };
  const workerNo = Object.prototype.hasOwnProperty.call(options, "workerNo")
    ? options.workerNo
    : "W-017";
  if (workerNo !== undefined) headers["x-worker-no"] = workerNo;
  const result = {
    method: "POST",
    path: options.path ?? "/maintenance/tool-usages",
    headers,
    body: options.body ?? { moldId: 7 },
  } as unknown as Request;
  if (options.attach !== false)
    attachSession(result, { userId: options.userId ?? 17 } as Session);
  return result;
}
