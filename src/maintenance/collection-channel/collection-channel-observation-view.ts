import { maintenanceInstantFromEpoch } from "../maintenance-instant";

export interface CollectionChannelObservationProjection {
  channel_key: string;
  last_value: string | null;
  observed_epoch_microseconds: string;
  already_mapped: boolean;
  total_count: bigint;
}

export interface CollectionChannelObservationView {
  channelKey: string;
  lastValue?: string;
  observedAt: string;
  alreadyMapped: boolean;
}

export function collectionChannelObservationView(
  row: CollectionChannelObservationProjection,
): CollectionChannelObservationView {
  const view: CollectionChannelObservationView = {
    channelKey: row.channel_key,
    observedAt: maintenanceInstantFromEpoch(row.observed_epoch_microseconds).utcIso,
    alreadyMapped: row.already_mapped,
  };
  if (row.last_value !== null) view.lastValue = row.last_value;
  return view;
}
