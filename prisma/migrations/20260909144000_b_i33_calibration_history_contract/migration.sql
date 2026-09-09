-- I-33 A22: extend calibration history without rewriting legacy rows.
ALTER TABLE quality.equipment_calibration
  ADD COLUMN history_type_code app.code_t,
  ADD COLUMN agency_type_code app.code_t,
  ADD COLUMN agency_name varchar(200),
  ADD COLUMN tolerance_note text,
  ADD COLUMN recorded_by bigint REFERENCES app.app_user(app_user_id),
  ADD COLUMN blocks_use boolean NOT NULL DEFAULT false,
  ADD COLUMN cleared_at timestamptz,
  ADD COLUMN cleared_by bigint REFERENCES app.app_user(app_user_id);

-- Typed rows are unique by history type. Legacy rows retain their original
-- equipment/date uniqueness without being classified retroactively.
ALTER TABLE quality.equipment_calibration
  DROP CONSTRAINT uq_equipment_calibration;

CREATE UNIQUE INDEX uq_equipment_calibration_typed
  ON quality.equipment_calibration(equipment_id, calibration_date, history_type_code)
  WHERE history_type_code IS NOT NULL;

CREATE UNIQUE INDEX uq_equipment_calibration_legacy
  ON quality.equipment_calibration(equipment_id, calibration_date)
  WHERE history_type_code IS NULL;

COMMENT ON COLUMN quality.equipment_calibration.history_type_code IS
  'Calibration history type. Legacy NULL rows are not inferred as CALIBRATION.';
COMMENT ON COLUMN quality.equipment_calibration.recorded_by IS
  'Authenticated recording user, distinct from calibrated_by and cleared_by.';
COMMENT ON COLUMN quality.equipment_calibration.blocks_use IS
  'Explicit use-blocking decision. The contract default is false.';
COMMENT ON COLUMN quality.equipment_calibration.cleared_at IS
  'Set by the unblock action without rewriting or deleting the history entry.';
