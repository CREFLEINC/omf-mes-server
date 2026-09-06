import {
  IF_WO_CLOSE,
  OUTBOX_DIRECTION,
  OUTBOX_PENDING,
  OutboxEnqueueInput,
  OutboxService,
  Tx,
  outboxMessageKey,
} from "./outbox.service";

const NEW_ID = 4100n;
const QUEUED_ID = 77n;

type Args = Record<string, unknown>;

/**
 * 「그 트랜잭션의 표」를 흉내낸다(`lot-registry.service.spec.ts` 와 같은 방식) — 어느 표를
 * 어떤 순서로 읽고 썼는지가 이 스위트의 목이라 호출을 부른 순서 그대로 담는다.
 */
function fake(seed: { queued?: boolean } = {}) {
  const calls: string[] = [];
  const created: Args[] = [];
  const looked: Args[] = [];
  const record =
    <T>(name: string, result: (a: Args) => T) =>
    async (a: Args) => {
      calls.push(name);
      return result(a);
    };
  const tx = {
    integration_message: {
      findUnique: record("message.findUnique", (a) => {
        looked.push(a.where as Args);
        return seed.queued === true
          ? { integration_message_id: QUEUED_ID }
          : null;
      }),
      create: record("message.create", (a) => {
        created.push(a.data as Args);
        return { integration_message_id: NEW_ID + BigInt(created.length - 1) };
      }),
    },
  };
  return {
    tx: tx as unknown as Tx,
    calls,
    created,
    looked,
    service: new OutboxService(),
  };
}

function input(extra: Partial<OutboxEnqueueInput> = {}): OutboxEnqueueInput {
  return {
    interfaceCode: IF_WO_CLOSE,
    messageKey: outboxMessageKey(IF_WO_CLOSE, "WO-20260906-0001"),
    targetTypeCode: "WORK_ORDER",
    targetId: 501n,
    payload: {
      header: { workOrderNo: "WO-20260906-0001" },
      sendItems: ["MATERIAL"],
    },
    ...extra,
  };
}

describe("OutboxService", () => {
  it("아웃박스 — `message_key` 는 `{인터페이스}:{문서번호}` 이고 버전을 안 붙인다", async () => {
    // 재마감 금지(R83) · `trg_work_order_closed_immutable` 이라 한 W/O 는 평생 한 번이다 —
    // 버전을 붙이면 그 물리 그물이 뜻을 잃는다.
    expect(outboxMessageKey(IF_WO_CLOSE, "WO-20260906-0001")).toBe(
      "IF-WO-CLOSE-SEND:WO-20260906-0001",
    );
    expect(outboxMessageKey("IF-SHIPMENT-CONFIRM-SEND", "SH-0007")).toBe(
      "IF-SHIPMENT-CONFIRM-SEND:SH-0007",
    );

    const { tx, created, service } = fake();
    await service.enqueue(tx, input());

    expect(created[0].message_key).toBe("IF-WO-CLOSE-SEND:WO-20260906-0001");
  });

  it("아웃박스 — 같은 키가 이미 있으면 던지지 않고 `alreadyQueued:true` 로 되읽는다", async () => {
    const { tx, calls, looked, service } = fake({ queued: true });

    const result = await service.enqueue(tx, input());

    expect(result).toEqual({
      integrationMessageId: QUEUED_ID,
      alreadyQueued: true,
    });
    // 되읽는 키가 곧 유일 제약 칸이다 — 다른 칸으로 찾으면 흡수가 헛돈다.
    expect(looked).toEqual([
      { message_key: "IF-WO-CLOSE-SEND:WO-20260906-0001" },
    ]);
    // INSERT 가 아예 안 나간다 — P2002 를 잡아 되읽는 길은 abort 된 tx 안이라 막힌다(25P02).
    expect(calls).toEqual(["message.findUnique"]);
  });

  it("아웃박스 — 개발품 판정 칸이 없어 전건 적재한다", async () => {
    const { tx, calls, created, service } = fake();

    const first = await service.enqueue(tx, input());
    const second = await service.enqueue(
      tx,
      input({
        messageKey: outboxMessageKey(IF_WO_CLOSE, "WO-20260906-0002"),
        targetId: 502n,
      }),
    );

    expect(first.alreadyQueued).toBe(false);
    expect(second).toEqual({
      integrationMessageId: NEW_ID + 1n,
      alreadyQueued: false,
    });
    expect(created).toHaveLength(2);
    // 품목을 보지도 않는다 — `mdm.item` 에 개발품 칸이 없어 분기 자체를 두지 않았다.
    expect(calls).toEqual([
      "message.findUnique",
      "message.create",
      "message.findUnique",
      "message.create",
    ]);
  });

  it("아웃박스 — 새 행은 `OUTBOUND`·`PENDING` 이고 `retry_count`·`available_at` 을 쓰지 않는다", async () => {
    const { tx, created, service } = fake();

    const result = await service.enqueue(tx, input());

    expect(result).toEqual({
      integrationMessageId: NEW_ID,
      alreadyQueued: false,
    });
    expect(created[0]).toEqual({
      message_key: "IF-WO-CLOSE-SEND:WO-20260906-0001",
      interface_code: IF_WO_CLOSE,
      direction_code: OUTBOX_DIRECTION,
      target_type_code: "WORK_ORDER",
      target_id: 501n,
      payload: {
        header: { workOrderNo: "WO-20260906-0001" },
        sendItems: ["MATERIAL"],
      },
      status_code: OUTBOX_PENDING,
    });
    expect(OUTBOX_DIRECTION).toBe("OUTBOUND");
    expect(OUTBOX_PENDING).toBe("PENDING");
  });
});
