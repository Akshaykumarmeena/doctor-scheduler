// "Is this slot inside the doctor's working hours?" as one SQL expression, shared by the week view (to flag kept
// bookings, decision 1a) and the working-hours change (to block / reopen slots).
//
// A slot is covered when an active weekly rule exists for its LOCAL weekday and date, and the slot's local
// start..end fits inside that rule's start..end.
export function coveredByHoursSql(slot: string, doctor: string) {
  return `EXISTS (
    SELECT 1 FROM schedule_templates t
     WHERE t.doctor_id = ${slot}.doctor_id
       AND t.weekday = extract(isodow FROM (lower(${slot}.during) AT TIME ZONE ${doctor}.tz))
       AND (lower(${slot}.during) AT TIME ZONE ${doctor}.tz)::date >= t.valid_from
       AND (t.valid_to IS NULL OR (lower(${slot}.during) AT TIME ZONE ${doctor}.tz)::date <= t.valid_to)
       AND (lower(${slot}.during) AT TIME ZONE ${doctor}.tz)::time >= t.start_local
       AND (upper(${slot}.during) AT TIME ZONE ${doctor}.tz)::time <= t.end_local
       AND (upper(${slot}.during) AT TIME ZONE ${doctor}.tz)::time > t.start_local)`;
}

/** "Does any time-off of this doctor overlap this slot?" */
export function inTimeOffSql(slot: string) {
  return `EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.doctor_id = ${slot}.doctor_id AND e.during && ${slot}.during)`;
}
