-- Up Migration

-- The phone receptionist (src/voice.ts): each store can have one phone number. Calls to it reach the voice agent,
-- which looks the store up by the number that was called.
CREATE TABLE voice_lines (
  number      text PRIMARY KEY CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
  tenant_id   uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  -- Where urgent calls are put through to (the owner's mobile), E.164; null: take a message instead.
  forward_to  text CHECK (forward_to IS NULL OR forward_to ~ '^\+[1-9][0-9]{6,14}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per answered call: what happened, for the owner's call log and summary email.
CREATE TABLE voice_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  caller      text,
  seconds     integer NOT NULL CHECK (seconds >= 0),
  outcome     text NOT NULL CHECK (outcome IN ('booked', 'message', 'transferred', 'answered', 'hung_up')),
  urgent      boolean NOT NULL DEFAULT false,
  summary     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_calls_tenant_idx ON voice_calls (tenant_id, created_at DESC);

-- Seconds of calls per store per calendar month (UTC), against the plan's minutes.
CREATE TABLE voice_usage (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month       date NOT NULL,
  seconds     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

-- Down Migration

DROP TABLE voice_usage;
DROP TABLE voice_calls;
DROP TABLE voice_lines;
