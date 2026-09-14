'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { getTicket } from './ticket';

const SAMPLE_RATE = 24000; // rate of the Opus stream, set by the server's encoder (server/src/opus.ts)
const PACKET_US = 20_000; // 20 ms packets: only the decoder timestamps depend on it, playback is scheduled by duration
const MAX_PREV_LINES = 3;
const LINE_MAX_CHARS = 120;

// Inlined at build time from NEXT_PUBLIC_SERVER_URL (root .env locally, host variables in production)
const CONFIGURED_SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL;

// Shapes produced by the server: /info (via /api/info) and the /listen text frames
type Info = { langs: string[]; capabilities?: { subtitles?: boolean } };
type Status = { text: string; on: boolean };
type ServerMessage = { type: 'subtitle'; delta: string } | { type: 'status'; ingest: boolean };

// Human-readable name in the language itself ("English", "français"), falls back to the code
function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

const BARS = 64; // waveform bars

export default function Page() {
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [langs, setLangs] = useState<string[]>([]);
  const [lang, setLang] = useState('');
  const [status, setStatus] = useState<Status>({ text: 'loading languages...', on: false });
  const [listening, setListening] = useState(false);
  const [subtitlesHidden, setSubtitlesHidden] = useState(false);
  const [currentLine, setCurrentLine] = useState('');
  const [prevLines, setPrevLines] = useState<string[]>([]);

  // Mutable audio/socket state, not rendered
  const ctx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const rafId = useRef(0);
  const nextTime = useRef(0);
  const ws = useRef<WebSocket | null>(null);
  const decoder = useRef<AudioDecoder | null>(null); // one per connection, see connect()
  const packetTs = useRef(0);
  const retryMs = useRef(1000);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentLineRef = useRef('');
  const attempt = useRef(0); // bumped by disconnect(): a connect() still waiting for its ticket must give up

  useEffect(() => {
    setServerUrl(CONFIGURED_SERVER_URL || '');
  }, []);

  // --- languages: from /api/info, the Next route handler that calls GET /info server side ---

  useEffect(() => {
    if (serverUrl === null) return;
    if (!serverUrl) { setStatus({ text: 'NEXT_PUBLIC_SERVER_URL not configured', on: false }); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/info');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { langs, capabilities } = (await res.json()) as Info;
        if (cancelled) return;
        setSubtitlesHidden(capabilities?.subtitles === false); // provider without transcripts
        setLangs(langs);
        setLang(langs[0] || '');
        setStatus({ text: 'not connected', on: false });
      } catch {
        if (cancelled) return;
        setStatus({ text: 'cannot reach server, retrying in 5 s', on: false });
        timer = setTimeout(load, 5000);
      }
    }
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [serverUrl]);

  // --- audio ---------------------------------------------------------------

  // Binary frames are Opus packets: they go through the WebCodecs decoder, which calls playChunk()
  function decodePacket(packet: ArrayBuffer) {
    const d = decoder.current;
    if (d?.state !== 'configured') return;
    d.decode(new EncodedAudioChunk({ type: 'key', timestamp: packetTs.current, duration: PACKET_US, data: packet }));
    packetTs.current += PACKET_US;
  }

  function openDecoder() {
    closeDecoder();
    // A decoder that errors is dead: dropping the socket makes the retry open a fresh one
    const d = new AudioDecoder({ output: playChunk, error: () => ws.current?.close() });
    d.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    decoder.current = d;
    packetTs.current = 0;
  }

  function closeDecoder() {
    if (decoder.current && decoder.current.state !== 'closed') decoder.current.close();
    decoder.current = null;
  }

  function playChunk(data: AudioData) {
    const ac = ctx.current;
    const an = analyser.current;
    const frames = data.numberOfFrames;
    const rate = data.sampleRate; // the browser's decoder picks the output rate (48 kHz in some): trust it, not SAMPLE_RATE
    if (!ac || !an || frames === 0) { data.close(); return; } // togglePlay() creates both before the first connect()
    const f32 = new Float32Array(frames);
    data.copyTo(f32, { planeIndex: 0, format: 'f32-planar' });
    data.close();

    const buffer = ac.createBuffer(1, frames, rate);
    buffer.copyToChannel(f32, 0);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(an);

    const now = ac.currentTime;
    if (nextTime.current < now + 0.05) nextTime.current = now + 0.1; // queue empty or behind: realign
    src.start(nextTime.current);
    nextTime.current += buffer.duration;
  }

  // --- subtitles -----------------------------------------------------------

  function addSubtitle(delta: string) {
    let line = currentLineRef.current + delta;
    if (line.length > LINE_MAX_CHARS && /[.!?]\s*$/.test(line)) {
      const done = line.trim();
      setPrevLines((prev) => [...prev, done].slice(-MAX_PREV_LINES));
      line = '';
    }
    currentLineRef.current = line;
    setCurrentLine(line);
  }

  function resetText() {
    currentLineRef.current = '';
    setCurrentLine('');
    setPrevLines([]);
  }

  // --- websocket -----------------------------------------------------------

  function disconnect() {
    attempt.current++;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (ws.current) { ws.current.onclose = null; ws.current.close(); ws.current = null; }
    closeDecoder();
  }

  function scheduleRetry(targetLang: string) {
    setStatus({ text: `disconnected, retrying in ${retryMs.current / 1000} s`, on: false });
    retryTimer.current = setTimeout(() => connect(targetLang), retryMs.current);
    retryMs.current = Math.min(retryMs.current * 2, 5000);
  }

  async function connect(targetLang: string) {
    const mine = ++attempt.current;
    setStatus({ text: `connecting (${targetLang})...`, on: false });
    let ticket: string | null = null;
    try { ticket = await getTicket(); } catch { /* Next unreachable: retry below */ } // fresh on every attempt: it expires in 50 s
    if (mine !== attempt.current) return; // Stop or language change while waiting for the ticket
    if (!ticket) { scheduleRetry(targetLang); return; }
    const socket = new WebSocket(`${serverUrl}/listen?lang=${targetLang}&ticket=${encodeURIComponent(ticket)}`);
    socket.binaryType = 'arraybuffer';
    ws.current = socket;
    openDecoder();

    socket.onopen = () => {
      retryMs.current = 1000;
      setStatus({ text: `connected (${targetLang}), waiting for audio`, on: true });
    };

    socket.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { decodePacket(ev.data); return; }
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data as string) as ServerMessage; } catch { return; }
      if (msg.type === 'subtitle') addSubtitle(msg.delta);
      else if (msg.type === 'status') {
        setStatus({ text: msg.ingest ? `connected (${targetLang}), receiving audio` : `connected (${targetLang}), no active source`, on: true });
      }
    };

    socket.onclose = (ev) => {
      ws.current = null;
      if (ev.code === 4000) { setStatus({ text: 'language not available on the server', on: false }); setListening(false); return; }
      if (ev.code === 4001) { setStatus({ text: 'not authorized', on: false }); setListening(false); return; }
      scheduleRetry(targetLang);
    };

    socket.onerror = () => { /* onclose handles the retry */ };
  }

  // --- audio waveform: voice-message style, one centered bar per instant, scrolling left as audio plays

  useEffect(() => {
    if (!listening) return;
    const el = canvas.current;
    const an = analyser.current;
    const g = el?.getContext('2d');
    if (!el || !an || !g) return; // togglePlay() creates the analyser before setting listening
    const samples = new Uint8Array(an.fftSize);
    const levels: number[] = new Array(BARS).fill(0); // loudness history, oldest first
    const color = getComputedStyle(el).color;
    const draw = () => { // arrow, not a hoisted declaration: keeps the null checks above in scope for TS
      an.getByteTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v - 128));
      levels.push(peak / 128);
      levels.shift();
      const { width, height } = el;
      const step = width / BARS;
      const mid = height / 2;
      g.clearRect(0, 0, width, height);
      g.strokeStyle = color;
      g.lineWidth = step * 0.4;
      g.lineCap = 'round';
      levels.forEach((level, i) => {
        const half = Math.max(g.lineWidth / 2, level * (mid - g.lineWidth)); // dot when silent
        const x = i * step + step / 2;
        g.beginPath();
        g.moveTo(x, mid - half);
        g.lineTo(x, mid + half);
        g.stroke();
      });
      rafId.current = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(rafId.current); g.clearRect(0, 0, el.width, el.height); };
  }, [listening]);

  // --- UI ------------------------------------------------------------------

  async function togglePlay() {
    if (listening) {
      setListening(false);
      disconnect();
      setStatus({ text: 'not connected', on: false });
      return;
    }
    if (typeof AudioDecoder === 'undefined') { setStatus({ text: 'browser not supported: no WebCodecs', on: false }); return; }
    if (!ctx.current) {
      ctx.current = new AudioContext();
      analyser.current = ctx.current.createAnalyser();
      analyser.current.connect(ctx.current.destination);
    }
    await ctx.current.resume(); // requires a user gesture
    nextTime.current = 0;
    setListening(true);
    resetText();
    connect(lang);
  }

  function changeLang(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setLang(next);
    if (!listening) return;
    disconnect();
    nextTime.current = 0;
    resetText();
    connect(next);
  }

  useEffect(() => disconnect, []); // close the socket on unmount

  return (
    <>
      <p className="eyebrow">Live translation · AI</p>
      <h1>Simultan<span>AI</span></h1>
      <div className="controls">
        <select id="lang" value={lang} onChange={changeLang} disabled={langs.length === 0}>
          {langs.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
        </select>
        <button id="play" className={listening ? 'stop' : ''} onClick={togglePlay} disabled={!serverUrl || langs.length === 0}>{listening ? 'Stop' : 'Listen'}</button>
        <span id="status" className={status.on ? 'on' : ''}>{status.text}</span>
      </div>
      <div id="subtitles" hidden={subtitlesHidden}>
        {prevLines.map((line, i) => <div key={i} className="prev">{line}</div>)}
        <div>{currentLine}</div>
      </div>
      <canvas id="viz" ref={canvas} width={640} height={96} />
      <footer>Powered by <a href="https://www.fairflai.com">Fairflai</a></footer>
    </>
  );
}
