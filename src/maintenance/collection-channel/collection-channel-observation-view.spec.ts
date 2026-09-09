import {
  CollectionChannelObservationProjection,
  collectionChannelObservationView,
} from "./collection-channel-observation-view";

describe("collectionChannelObservationView", () => {
  it("관측 원문·마이크로초·등록 여부를 네 응답칸으로 보존한다", () => {
    expect(collectionChannelObservationView(projection(""))).toEqual({
      channelKey: "PRS41.TEMP.01",
      lastValue: "",
      observedAt: "2026-09-09T03:42:03.123456Z",
      alreadyMapped: true,
    });
  });

  it("NULL 관측값은 키를 생략한다", () => {
    const view = collectionChannelObservationView(projection(null));
    expect(view).toEqual({
      channelKey: "PRS41.TEMP.01",
      observedAt: "2026-09-09T03:42:03.123456Z",
      alreadyMapped: true,
    });
    expect(view).not.toHaveProperty("lastValue");
  });
});

function projection(lastValue: string | null): CollectionChannelObservationProjection {
  return {
    channel_key: "PRS41.TEMP.01",
    last_value: lastValue,
    observed_epoch_microseconds: "1788925323123456",
    already_mapped: true,
    total_count: 1n,
  };
}
