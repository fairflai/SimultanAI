import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Translator } from './translator.ts';
import { createProvider } from './providers/index.ts';
import type { Provider } from './providers/provider.ts';
import * as broadcast from './broadcast.ts';
import { secretKey, verifyTicket } from './ticket.ts';

const PORT = Number(process.env.PORT) || 8000;
const LANGS = (process.env.TARGET_LANGS || 'en').split(',').map((s) => s.trim()).filter(Boolean);
// The source must stream continuously, silence included: this long without a byte means the link is dead
const INGEST_IDLE_MS = Number(process.env.INGEST_IDLE_MS) || 15_000;

function loadProvider(): Provider {
  try {
    return createProvider();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
const provider = loadProvider();

for (const name of [...provider.requiredEnv, 'INGEST_TOKEN', 'INFO_TOKEN', 'LISTEN_SECRET']) {
  if (!process.env[name]) {
    console.error(`missing env var ${name}`);
    process.exit(1);
  }
}

interface Ingest { translators: Translator[]; startedAt: number; bytes: number }
let ingest: Ingest | null = null;

function json(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req: http.IncomingMessage, token: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(req.headers.authorization ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!authorized(req, process.env.INGEST_TOKEN)) {
    console.log(`ingest rejected from ${req.socket.remoteAddress}: bad token`);
    res.writeHead(401, { connection: 'close' });
    res.end('unauthorized');
    return;
  }
  if (ingest) {
    console.log(`ingest rejected from ${req.socket.remoteAddress}: already active`);
    res.writeHead(409, { connection: 'close' });
    res.end('ingest already active');
    return;
  }

  const translators = LANGS.map((lang) => new Translator(provider, lang));
  const current: Ingest = { translators, startedAt: Date.now(), bytes: 0 };
  ingest = current;
  console.log(`ingest started from ${req.socket.remoteAddress}, languages: ${LANGS.join(',')}`);
  broadcast.textAll({ type: 'status', ingest: true });

  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`ingest idle for ${INGEST_IDLE_MS} ms, dropping it`);
      req.destroy(); // fires 'close' below, which stops the ingest
    }, INGEST_IDLE_MS);
  };
  armIdle();

  req.on('data', (chunk: Buffer) => {
    current.bytes += chunk.length;
    armIdle();
    for (const t of translators) t.push(chunk);
  });

  const stop = () => {
    clearTimeout(idleTimer);
    if (ingest !== current) return;
    const seconds = ((Date.now() - current.startedAt) / 1000).toFixed(1);
    console.log(`ingest stopped after ${seconds} s, ${current.bytes} bytes`);
    for (const t of translators) t.close();
    ingest = null;
    broadcast.textAll({ type: 'status', ingest: false });
  };

  req.on('end', () => {
    stop();
    res.writeHead(200);
    res.end();
  });
  req.on('close', stop);
  req.on('error', (err) => {
    console.error(`ingest error: ${err.message}`);
    stop();
  });
}

// Health = process up AND the vendor answers a free models.get for the configured model (see Provider.healthRequest).
// No body beyond ok/unavailable: operational data lives in /info. The reason goes to the log only, never the URL.
async function handleHealth(res: http.ServerResponse): Promise<void> {
  const { url, headers } = provider.healthRequest();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    res.writeHead(200);
    res.end('ok');
  } catch (err) {
    console.error(`health: provider ${provider.name} probe failed: ${err instanceof Error ? err.message : String(err)}`);
    res.writeHead(503);
    res.end('unavailable');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return void handleHealth(res);
  }
  if (req.method === 'GET' && url.pathname === '/info') {
    if (!authorized(req, process.env.INFO_TOKEN)) {
      res.writeHead(401);
      return res.end('unauthorized');
    }
    return json(res, 200, {
      ingest: !!ingest,
      langs: LANGS,
      listeners: broadcast.counts(),
      provider: provider.name,
      model: provider.model,
      capabilities: provider.capabilities,
    });
  }
  if (req.method === 'POST' && url.pathname === '/ingest') {
    return handleIngest(req, res);
  }
  res.writeHead(404);
  res.end();
});

// The ffmpeg POST lasts for hours: without this Node closes the request after 5 minutes.
server.requestTimeout = 0;
// TCP keepalive surfaces a dead link at the socket level too
server.on('connection', (socket) => socket.setKeepAlive(true, 10_000));

const wss = new WebSocketServer({ noServer: true });
const listenKey = secretKey(process.env.LISTEN_SECRET!);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/listen') {
    socket.destroy();
    return;
  }
  const lang = url.searchParams.get('lang') ?? '';
  const ticket = url.searchParams.get('ticket') ?? '';
  // Rejections happen after the upgrade so the page gets a 4xxx code it can tell apart from a network drop
  wss.handleUpgrade(req, socket, head, (ws) => {
    void verifyTicket(ticket, listenKey).then((ok) => {
      if (!ok) {
        console.log(`listen rejected from ${req.socket.remoteAddress}: bad ticket`);
        ws.close(4001, 'unauthorized');
        return;
      }
      if (!LANGS.includes(lang)) {
        ws.close(4000, 'unsupported language');
        return;
      }
      broadcast.join(lang, ws);
      ws.send(JSON.stringify({ type: 'status', ingest: !!ingest, lang }));
    });
  });
});

await broadcast.init(LANGS); // one Opus encoder per language, the codec loads asynchronously
server.listen(PORT, () => {
  console.log(`listening on :${PORT}, provider ${provider.name} (${provider.model}), languages ${LANGS.join(',')}`);
});
