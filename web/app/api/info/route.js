// Server-side only: calls GET /info with INFO_TOKEN and forwards the browser just what the page needs.
// The token and the full /info body (listeners, model, ...) never reach the client.
export async function GET() {
  try {
    const base = process.env.NEXT_PUBLIC_SERVER_URL.replace(/^ws/, 'http'); // undefined → throws → 502
    const res = await fetch(`${base}/info`, { headers: { authorization: `Bearer ${process.env.INFO_TOKEN}` } });
    if (!res.ok) return new Response(null, { status: 502 });
    const { langs, capabilities } = await res.json();
    return Response.json({ langs, capabilities });
  } catch {
    return new Response(null, { status: 502 });
  }
}
