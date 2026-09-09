import { HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { attachSession } from "../../auth/session-resolver.service";
import type { Session } from "../../auth/session.types";
import { collectionChannelWriteContext } from "./collection-channel-write-context";

describe("collection channel write context", () => {
  it("세션 주체·원문 본문·오퍼레이션을 멱등 지문에 담는다", () => {
    expect(collectionChannelWriteContext(createRequest(), HttpStatus.CREATED)).toMatchObject({
      key: "idem-1",
      appUserId: 17,
      successStatus: 201,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("세션·본문·경로가 달라지면 지문도 달라진다", () => {
    const baseline = collectionChannelWriteContext(createRequest(), HttpStatus.CREATED).fingerprint;
    for (const request of [
      createRequest({ userId: 18 }),
      createRequest({ body: { equipmentId: 8, channelKey: "A" } }),
      createRequest({ method: "PUT", path: "/maintenance/collection-channels/7" }),
    ]) {
      expect(collectionChannelWriteContext(request, HttpStatus.OK).fingerprint).not.toBe(baseline);
    }
  });

  it("If-Match는 성공 재생을 막지 않도록 지문에서 제외한다", () => {
    const first = collectionChannelWriteContext(
      createRequest({ method: "PUT", path: "/maintenance/collection-channels/7", ifMatch: "1" }),
      HttpStatus.OK,
    );
    const replay = collectionChannelWriteContext(
      createRequest({ method: "PUT", path: "/maintenance/collection-channels/7", ifMatch: "2" }),
      HttpStatus.OK,
    );
    expect(first.fingerprint).toBe(replay.fingerprint);
  });

  it("세션이 없으면 401이다", () => {
    expect(() => collectionChannelWriteContext(createRequest({ attach: false }), HttpStatus.CREATED)).toThrow(
      UnauthorizedException,
    );
  });
});

interface RequestOptions {
  attach?: boolean;
  body?: object;
  method?: string;
  path?: string;
  userId?: number;
  ifMatch?: string;
}

function createRequest(options: RequestOptions = {}): Request {
  const request = {
    method: options.method ?? "POST",
    path: options.path ?? "/maintenance/collection-channels",
    headers: { "idempotency-key": "idem-1", ...(options.ifMatch ? { "if-match": options.ifMatch } : {}) },
    body: options.body ?? { equipmentId: 7, channelKey: "A" },
  } as unknown as Request;
  if (options.attach !== false) {
    attachSession(request, { userId: options.userId ?? 17 } as Session);
  }
  return request;
}
