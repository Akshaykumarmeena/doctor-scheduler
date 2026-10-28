-- "Break it" demo: try to double-book a doctor and watch Postgres refuse.
-- Run:  docker compose exec -T postgres psql -U scheduler -d scheduler < docs/learning/break-it.sql
-- Everything runs inside one transaction that is rolled back, so it leaves no data behind.
BEGIN;

INSERT INTO doctors (id, name, specialty, clinic, area, lat, lng)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'Dr. Demo', 'Dermatology', 'Demo Clinic', 'Indiranagar', 12.9719, 77.6412);

INSERT INTO patients (id, name, phone) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Patient One', '+910000000001'),
  ('00000000-0000-0000-0000-0000000000a2', 'Patient Two', '+910000000002');

-- Two 15-minute slots: 09:00-09:15 and 09:15-09:30 IST (= 03:30Z and 03:45Z).
INSERT INTO slots (id, doctor_id, during) VALUES
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-0000000000d1', '[2026-11-02 03:30Z, 2026-11-02 03:45Z)'),
  ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-0000000000d1', '[2026-11-02 03:45Z, 2026-11-02 04:00Z)');

-- Patient One books 09:15-09:30.
INSERT INTO appointments (id, slot_id, doctor_id, patient_id, visit_type, idempotency_key)
VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000052',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'in_person', 'demo-1');
UPDATE slots SET status = 'booked', appointment_id = '00000000-0000-0000-0000-0000000000e1', version = version + 1
WHERE id = '00000000-0000-0000-0000-000000000052';

-- Patient Two wants a 30-minute visit 09:00-09:30. Overlapping OPEN rows are allowed,
-- so this insert succeeds...
INSERT INTO slots (id, doctor_id, during) VALUES
  ('00000000-0000-0000-0000-000000000053', '00000000-0000-0000-0000-0000000000d1', '[2026-11-02 03:30Z, 2026-11-02 04:00Z)');
INSERT INTO appointments (id, slot_id, doctor_id, patient_id, visit_type, idempotency_key)
VALUES ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000053',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'in_person', 'demo-2');

-- ...but booking it must fail. Its START (09:00) differs from Patient One's (09:15), so
-- UNIQUE(doctor_id, start) would have let it through. The EXCLUDE constraint sees the overlap:
--   ERROR:  conflicting key value violates exclusion constraint "slots_no_overlapping_commitments"
UPDATE slots SET status = 'booked', appointment_id = '00000000-0000-0000-0000-0000000000e2', version = version + 1
WHERE id = '00000000-0000-0000-0000-000000000053';

ROLLBACK;
