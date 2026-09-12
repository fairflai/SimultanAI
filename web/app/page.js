'use client';

import { useEffect, useRef, useState } from 'react';
import { getTicket } from './ticket';

const SAMPLE_RATE = 24000;
const MAX_PREV_LINES = 3;
const LINE_MAX_CHARS = 120;

// Inlined at build time from NEXT_PUBLIC_SERVER_URL (root .env locally, host variables in production)
const CONFIGURED_SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL;

// Human-readable name in the language itself ("English", "français"), falls back to the code
function languageName(code) {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

const BARS = 64; // waveform bars

export default function Page() {
  const [serverUrl, setServerUrl] = useState(null);
  const [langs, setLangs] = useState([]);
  const [lang, setLang] = useState('');
  const [status, setStatus] = useState({ text: 'loading languages...', on: false });
  const [listening, setListening] = useState(false);
  const [subtitlesHidden, setSubtitlesHidden] = useState(false);
  const [currentLine, setCurrentLine] = useState('');
  const [prevLines, setPrevLines] = useState([]);

  // Mutable audio/socket state, not rendered
  const ctx = useRef(null);
  const analyser = useRef(null);
  const canvas = useRef(null);
  const rafId = useRef(0);
  const nextTime = useRef(0);
  const ws = useRef(null);
  const retryMs = useRef(1000);
  const retryTimer = useRef(null);
  const currentLineRef = useRef('');
  const attempt = useRef(0); // bumped by disconnect(): a connect() still waiting for its ticket must give up

  useEffect(() => {
    setServerUrl(CONFIGURED_SERVER_URL || '');
  }, []);

  // --- languages: from /api/info, the Next route handler that calls GET /info server side ---

  useEffect(() => {
    if (serverUrl === null) return;
    if (!serverUrl) { setStatus({ text: 'NEXT_PUBLIC_SERVER_URL not configured', on: false }); return; }
    let timer = null;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/info');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { langs, capabilities } = await res.json();
        if (cancelled) return;
        setSubtitlesHidden(capabilities?.subtitles === false); // provider without transcripts
        setLangs(langs);
        setLang(langs[0] || '');
        setStatus({ text: 'not connected', on: false });
      } catch {
        if (cancelled) return;
        setStatus({ text: 'cannot reach server, retrying in 5s', on: false });
        timer = setTimeout(load, 5000);
      }
    }
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [serverUrl]);

  // --- audio ---------------------------------------------------------------

  function playChunk(arrayBuffer) {
    const evenLen = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
    if (evenLen === 0) return;
    const i16 = new Int16Array(arrayBuffer, 0, evenLen / 2);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

    const ac = ctx.current;
    const buffer = ac.createBuffer(1, f32.length, SAMPLE_RATE);
    buffer.copyToChannel(f32, 0);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser.current);

    const now = ac.currentTime;
    if (nextTime.current < now + 0.05) nextTime.current = now + 0.1; // queue empty or behind: realign
    src.start(nextTime.current);
    nextTime.current += buffer.duration;
  }

  // --- subtitles -----------------------------------------------------------

  function addSubtitle(delta) {
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
    clearTimeout(retryTimer.current);
    if (ws.current) { ws.current.onclose = null; ws.current.close(); ws.current = null; }
  }

  function scheduleRetry(targetLang) {
    setStatus({ text: `disconnected, retrying in ${retryMs.current / 1000}s`, on: false });
    retryTimer.current = setTimeout(() => connect(targetLang), retryMs.current);
    retryMs.current = Math.min(retryMs.current * 2, 5000);
  }

  async function connect(targetLang) {
    const mine = ++attempt.current;
    setStatus({ text: `connecting (${targetLang})...`, on: false });
    let ticket = null;
    try { ticket = await getTicket(); } catch { /* Next unreachable: retry below */ } // fresh on every attempt: it expires in 50 s
    if (mine !== attempt.current) return; // Stop or language change while waiting for the ticket
    if (!ticket) { scheduleRetry(targetLang); return; }
    const socket = new WebSocket(`${serverUrl}/listen?lang=${targetLang}&ticket=${encodeURIComponent(ticket)}`);
    socket.binaryType = 'arraybuffer';
    ws.current = socket;

    socket.onopen = () => {
      retryMs.current = 1000;
      setStatus({ text: `connected (${targetLang}), waiting for audio`, on: true });
    };

    socket.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { playChunk(ev.data); return; }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
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
    const g = el.getContext('2d');
    const samples = new Uint8Array(analyser.current.fftSize);
    const levels = new Array(BARS).fill(0); // loudness history, oldest first
    const color = getComputedStyle(el).color;
    function draw() {
      analyser.current.getByteTimeDomainData(samples);
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
    }
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

  function changeLang(e) {
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
