'use server';

// Server Action: runs on the Next server, where LISTEN_SECRET is available. The page calls it on every connection
// and puts the result in the /listen query string; the server verifies it in server/src/ticket.ts.
// Short-lived on purpose: the ticket is consumed within a second of being issued, and it is useless after 50 s.
import { SignJWT } from 'jose';

const TTL = '50s';

export async function getTicket() {
  const key = new TextEncoder().encode(process.env.LISTEN_SECRET);
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(TTL).sign(key);
}
