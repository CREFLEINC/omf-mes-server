import { UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { attachSession } from "../../auth/session-resolver.service";
import type { Session } from "../../auth/session.types";
import {
  downtimeCreateContext,
  downtimeUpdateContext,
} from "./downtime-write-context";

describe("downtime write context", () => {
  it("생성은 세션 주체와 귀속 사번을 담고 201 지문을 만든다", () => {
    const request = createRequest();
    const result = downtimeCreateContext(request);

    expect(result).toMatchObject({
      key: "idem-1",
      appUserId: 17,
      workerNo: "W-017",
      successStatus: 201,
    });
    expect(result.fingerprint).toHaveLength(64);
  });

  it("세션 주체·귀속 사번·본문·오퍼레이션은 각각 지문을 바꾼다", () => {
    const baseline = downtimeCreateContext(createRequest()).fingerprint;
    const cases = [
      createRequest({ userId: 18 }),
      createRequest({ workerNo: "W-018" }),
      createRequest({ body: { equipmentId: 8 } }),
      createRequest({ path: "/maintenance/other" }),
      createRequest({ method: "PUT" }),
    ];

    for (const request of cases) {
      expect(downtimeCreateContext(request).fingerprint).not.toBe(baseline);
    }
  });

  it("수정은 If-Match를 지문에서 제외하고 200을 사용한다", () => {
    const first = createRequest({ method: "PUT", ifMatch: '"3"' });
    const second = createRequest({ method: "PUT", ifMatch: '"4"' });

    const context = downtimeUpdateContext(first);
    expect(context).toMatchObject({ appUserId: 17, successStatus: 200 });
    expect(context.fingerprint).toBe(downtimeUpdateContext(second).fingerprint);
    expect(context).not.toHaveProperty("workerNo");
  });

  it.each([
    [undefined, "REQUIRED"],
    ["", "REQUIRED"],
    ["   ", "REQUIRED"],
    ["W".repeat(51), "RANGE"],
  ])("작업자 사번 %p를 %s로 거절한다", (workerNo, code) => {
    expect(() => downtimeCreateContext(createRequest({ workerNo }))).toThrow(
      expect.objectContaining({
        status: 400,
        errors: [expect.objectContaining({ field: "X-Worker-No", code })],
      }),
    );
  });

  it("50자 사번은 원문 그대로 보존한다", () => {
    const workerNo = ` ${"W".repeat(48)} `;
    expect(downtimeCreateContext(createRequest({ workerNo })).workerNo).toBe(
      workerNo,
    );
  });

  it("인증 가드가 세션을 붙이지 않은 요청은 401이다", () => {
    const request = createRequest({ attach: false });
    expect(() => downtimeUpdateContext(request)).toThrow(UnauthorizedException);
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  ifMatch?: string;
  method?: string;
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
  if (options.ifMatch !== undefined) headers["if-match"] = options.ifMatch;
  const request = {
    method: options.method ?? "POST",
    path: options.path ?? "/maintenance/downtimes",
    headers,
    body: options.body ?? { equipmentId: 7 },
  } as unknown as Request;
  if (options.attach !== false) {
    attachSession(request, { userId: options.userId ?? 17 } as Session);
  }
  return request;
}
