-- Transactional outbox: the booking API inserts an event row in the SAME transaction
-- as the state change; a relay later publishes unpublished rows to Redpanda.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,            -- monotonic, gives publish order
  doctor_id     uuid NOT NULL,                    -- shard key, also the Kafka partition key
  aggregate_id  uuid NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

-- The relay only ever reads the unpublished tail.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Stored response per Idempotency-Key so a retried write replays the first answer.
CREATE TABLE idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,                   -- same key + different body = 422
  status_code   integer,
  response      jsonb,                           -- NULL while the first request is in flight
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- For the TTL cleanup job.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
