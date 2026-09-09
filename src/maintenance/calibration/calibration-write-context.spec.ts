import { HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { attachSession } from "../../auth/session-resolver.service";
import type { Session } from "../../auth/session.types";
import { calibrationWriteContext } from "./calibration-write-context";

describe("calibration write context", () => {
  it("세션 주체·본문·오퍼레이션을 지문에 담고 지정 성공 상태를 쓴다", () => {
    const request = createRequest();
    expect(calibrationWriteContext(request, HttpStatus.CREATED)).toMatchObject({
      key: "idem-1",
      appUserId: 17,
      successStatus: 201,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(calibrationWriteContext(request, HttpStatus.OK)).toMatchObject({ successStatus: 200 });
  });

  it("세션·본문·오퍼레이션이 달라지면 지문도 달라진다", () => {
    const baseline = calibrationWriteContext(createRequest(), HttpStatus.CREATED).fingerprint;
    for (const request of [
      createRequest({ userId: 18 }),
      createRequest({ body: { equipmentId: 8 } }),
      createRequest({ path: "/maintenance/calibrations/7:clear" }),
    ]) {
      expect(calibrationWriteContext(request, HttpStatus.CREATED).fingerprint).not.toBe(baseline);
    }
  });

  it("세션이 붙지 않은 요청은 401이다", () => {
    expect(() =>
      calibrationWriteContext(createRequest({ attach: false }), HttpStatus.CREATED),
    ).toThrow(UnauthorizedException);
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  path?: string;
  userId?: number;
}

function createRequest(options: RequestOptions = {}): Request {
  const request = {
    method: "POST",
    path: options.path ?? "/maintenance/calibrations",
    headers: { "idempotency-key": "idem-1" },
    body: options.body ?? { equipmentId: 7 },
  } as unknown as Request;
  if (options.attach !== false) {
    attachSession(request, { userId: options.userId ?? 17 } as Session);
  }
  return request;
}
