// The matcher never writes `slots` itself (invariant 1: only booking-api does). To offer a slot it asks
// booking-api for a hold on the patient's behalf, like any client, with an Idempotency-Key.
import type { Hold } from '@ds/shared';

export interface HoldRequest {
  slotId: string;
  patientId: string;
  durationMinutes: 15 | 30;
  ttlSeconds: number;
}

export interface BookingApi {
  hold(req: HoldRequest, idempotencyKey: string): Promise<{ status: number; hold?: Hold; error?: string }>;
}

export function bookingApiClient(baseUrl: string): BookingApi {
  return {
    async hold(req, idempotencyKey) {
      const res = await fetch(`${baseUrl}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as Hold & { error?: string };
      return res.status === 201 ? { status: 201, hold: body } : { status: res.status, error: body.error };
    },
  };
}
