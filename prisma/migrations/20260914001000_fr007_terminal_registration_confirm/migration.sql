-- Registration completion belongs to one issued terminal-token generation.
ALTER TABLE mdm.terminal
  ADD COLUMN registered_token_version integer,
  ADD COLUMN registration_confirmed_at timestamptz(6);

ALTER TABLE mdm.terminal
  ADD CONSTRAINT ck_terminal_registration_confirmation
  CHECK ((registered_token_version IS NULL) = (registration_confirmed_at IS NULL));
