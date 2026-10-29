// The shape of a message on topic "appointments", as the outbox relay publishes it.
export interface BookingEvent {
  eventId: string;
  eventType: string;
  doctorId: string;
  aggregateId: string;
  occurredAt: string;
  payload: {
    // appointment.* payloads are an Appointment; hold.* payloads are { holdId, slotId, doctorId, patientId, start, end }
    id?: string;
    holdId?: string;
    slotId: string;
    doctorId: string;
    patientId: string;
    start: string;
    end: string;
    status?: string;
    /** appointment.cancelled only: 'doctor' when the doctor's time off cancelled it (Phase 5). */
    cancelledBy?: 'patient' | 'doctor';
    reason?: string;
  };
}

export interface RawMessage {
  key: string | null;
  value: string | null;
}

export function parseEvents(messages: RawMessage[]): BookingEvent[] {
  return messages.flatMap((m) => (m.value ? [JSON.parse(m.value) as BookingEvent] : []));
}
