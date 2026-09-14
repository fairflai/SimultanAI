// Listener ticket for GET /listen: a JWT HS256 signed by the web server with LISTEN_SECRET (web/app/ticket.ts),
// short-lived so the value in the query string is worthless within a minute. The server only verifies.
import { jwtVerify } from 'jose';

export const ALG = 'HS256';

export function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

// True only for a token signed with `key`, carrying an `exp` still in the future at `now`
export async function verifyTicket(ticket: string, key: Uint8Array, now = new Date()): Promise<boolean> {
  try {
    await jwtVerify(ticket, key, { algorithms: [ALG], requiredClaims: ['exp'], currentDate: now });
    return true;
  } catch {
    return false;
  }
}
