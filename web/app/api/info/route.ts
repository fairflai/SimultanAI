// Server-side only: calls GET /info with INFO_TOKEN and forwards the browser just what the page needs.
// The token and the full /info body (listeners, model, ...) never reach the client.
type Info = { langs: string[]; capabilities: { subtitles: boolean } };

export async function GET(): Promise<Response> {
  const base = process.env.NEXT_PUBLIC_SERVER_URL?.replace(/^ws/, 'http');
  if (!base) return new Response(null, { status: 502 }); // not configured
  try {
    const res = await fetch(`${base}/info`, { headers: { authorization: `Bearer ${process.env.INFO_TOKEN}` } });
    if (!res.ok) return new Response(null, { status: 502 });
    const { langs, capabilities } = (await res.json()) as Info;
    return Response.json({ langs, capabilities });
  } catch {
    return new Response(null, { status: 502 });
  }
}
