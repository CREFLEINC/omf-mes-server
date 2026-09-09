-- I-33 A21: add contract mapping fields without rewriting legacy channels.
ALTER TABLE maintenance.collection_channel
  ADD COLUMN channel_key varchar(100),
  ADD COLUMN signal_name varchar(200),
  ADD COLUMN inspection_item_id bigint REFERENCES quality.inspection_item_spec(inspection_item_spec_id),
  ADD COLUMN item_id bigint REFERENCES mdm.item(item_id),
  ADD COLUMN process_id bigint REFERENCES mdm.process(process_id),
  ALTER COLUMN channel_code DROP NOT NULL,
  ALTER COLUMN channel_name DROP NOT NULL,
  ALTER COLUMN data_type_code DROP NOT NULL;

-- NULL item/process values are explicit parts of the mapping scope. Inactive
-- mappings continue to reserve the same scope and are reactivated via PUT.
CREATE UNIQUE INDEX uq_collection_channel_mapping
  ON maintenance.collection_channel
    (equipment_id, channel_key, (item_id IS NULL), COALESCE(item_id, 0),
     (process_id IS NULL), COALESCE(process_id, 0))
  WHERE channel_key IS NOT NULL;

CREATE INDEX ix_collection_channel_inspection_item
  ON maintenance.collection_channel(inspection_item_id);

COMMENT ON COLUMN maintenance.collection_channel.channel_key IS
  'Raw equipment channel key. It is not inferred from legacy channel_code.';
COMMENT ON COLUMN maintenance.collection_channel.inspection_item_id IS
  'Quality inspection_item_spec row; revisions are not migrated automatically.';

-- I-33 T: latest observed value projection. A mapping row is not required.
CREATE TABLE maintenance.collection_channel_observation (
  equipment_id bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
  channel_key varchar(100) NOT NULL,
  last_value text,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (equipment_id, channel_key)
);

CREATE INDEX ix_collection_channel_observation_time
  ON maintenance.collection_channel_observation(observed_at DESC, equipment_id, channel_key);

COMMENT ON TABLE maintenance.collection_channel_observation IS
  'Latest observed snapshot per equipment and channel key. Writer ordering and raw history retention are separate integration responsibilities.';
