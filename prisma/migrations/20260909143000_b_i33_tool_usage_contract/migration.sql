-- I-33 A20: preserve legacy usage data while adding the contract fields.
ALTER TABLE maintenance.tool_usage
  ADD COLUMN collection_method_code app.code_t,
  ADD COLUMN conversion_base_qty numeric(20, 6),
  ADD COLUMN conversion_ratio numeric(20, 6),
  ADD COLUMN occurred_at timestamptz,
  ALTER COLUMN usage_type_code DROP NOT NULL,
  ALTER COLUMN used_from DROP NOT NULL;

COMMENT ON COLUMN maintenance.tool_usage.collection_method_code IS
  'ToolUsage collectionMethodCode: DIRECT or CONVERTED. This is separate from legacy usage_type_code.';
COMMENT ON COLUMN maintenance.tool_usage.occurred_at IS
  'Device-provided occurrence instant. Do not derive or backfill from used_from or created_at.';
COMMENT ON COLUMN maintenance.tool_usage.conversion_base_qty IS
  'Conversion base quantity captured with the usage event.';
COMMENT ON COLUMN maintenance.tool_usage.conversion_ratio IS
  'Conversion ratio captured with the usage event; the submitted shot count remains authoritative.';

CREATE INDEX ix_tool_usage_mold_occurred
  ON maintenance.tool_usage(mold_id, occurred_at DESC, tool_usage_id DESC);
