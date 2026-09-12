# SimultanAI

[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](server/Dockerfile)
[![OpenAI Realtime](https://img.shields.io/badge/OpenAI-Realtime-412991?logo=openai&logoColor=white)](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
[![Gemini Live](https://img.shields.io/badge/Gemini-Live-4285F4?logo=google&logoColor=white)](https://ai.google.dev/gemini-api/docs/live-api/live-translate)

<img align="left" width="100px" src="docs/images/logo.avif">

The project provides a system for simultaneous translation at live events: conferences, conventions, lectures, assemblies.

The speaker talks in their own language into the room microphone; the audience, from their own phones, pick a language and listen through headphones to the spoken translation, with subtitles on screen.
It replaces the interpreting booth and the radio receivers: a typical setup is a PC connected to the mixer and the venue Wi-Fi.

How it works: a PC captures the audio with ffmpeg (or another audio stream) and sends it to a server, which passes it to a real-time translation provider and redistributes the translated audio and subtitles to the listeners.

The provider is chosen in the `.env` (`PROVIDER=google|openai`); currently supported:

- Google Gemini `gemini-3.5-live-translate-preview`
- OpenAI `gpt-realtime-translate`

One session per language serves the whole room: 100 listeners cost the provider the same as a single one (see [Costs](#costs)).

```
microphone ──ffmpeg (HTTP POST + Bearer INGEST_TOKEN)───▶ Docker server ──WS (JWT ticket; audio + subtitles)──▶ web page
                                                                 │
                                                                 ├─▶ provider session, language 1
                                                                 ├─▶ provider session, language 2
                                                                 └─▶ ... one for each language in TARGET_LANGS
```

- `client/` ffmpeg scripts (nothing else runs on the PC)
- `server/` TypeScript run directly by Node 24 (type stripping, no build), Docker image for any container host.  
The providers live in `server/src/providers/`: an abstract `Provider` class with typed events, a factory and one implementation per provider in `impl/`; adding one means writing a file and registering it in the factory.
- `web/` Next.js page, a single client route

> [!IMPORTANT]
> The project should be considered experimental: so far it has only been used in controlled settings, not at large events.

## Contents

1. [Project scope](#project-scope)
2. [Configuration](#configuration)
   - [Running locally](#running-locally)
   - [Finding the microphone](#finding-the-microphone)
   - [Deploy](#deploy)
   - [Languages](#languages)
3. [Server API](#server-api)
4. [Costs and limits](#costs-and-limits)
5. [Security and privacy](#security-and-privacy)
6. [License](#license)

## Project scope

The client and the web page included in the project are meant as illustrations, since both the origin of the stream and the end-user experience change significantly from event to event.

The server is the real core of the project: it receives an audio stream over a channel protected by a shared secret, translates it into all the configured languages and exposes via API/WebSocket a set of audio tracks with their subtitles, one per language, which can be consumed in parallel by multiple clients of any kind.
It is distributed as a Docker image, since that is the most versatile form for a production deploy in heterogeneous environments: the same image runs unchanged on a PaaS, on Kubernetes, on a VM with Docker or on an on-premise server, and carries the Node runtime and the dependencies with it, so the only thing to provide is the environment variables.

> [!CAUTION]
> The server has no spending cap of its own.  
> Before the first public event set a hard monthly budget and alerts on the provider account: on OpenAI at platform.openai.com, on Google in the billing alerts of the Cloud project linked to the AI Studio key.

## Configuration

All settings live in the root `.env` (copy `.env.example`), split as in the file itself:

| Section | Variable | Meaning |
|---|---|---|
| SERVER | `PROVIDER` | translation provider, `openai` (default) or `google`; a single one for all languages |
| SERVER | `OPENAI_API_KEY` | OpenAI key, required with `PROVIDER=openai`, used only by the server |
| SERVER | `OPENAI_MODEL` | OpenAI model, default `gpt-realtime-translate` |
| SERVER | `GEMINI_API_KEY` | Google AI Studio key, required with `PROVIDER=google`, used only by the server |
| SERVER | `GEMINI_MODEL` | Gemini model, default `gemini-3.5-live-translate-preview` |
| SERVER | `ROTATE_MARGIN_MS` | how far ahead of expiry the replacement session is opened; empty = provider default (OpenAI 5 min, Gemini 2 min). Only useful to test rotation |
| SERVER | `INGEST_TOKEN` | shared secret between ffmpeg and the server for `POST /ingest`, 32 random bytes (`openssl rand -hex 32`) |
| SERVER + WEB | `INFO_TOKEN` | shared secret between the Next server and the server for `GET /info`, 32 random bytes |
| SERVER + WEB | `LISTEN_SECRET` | shared secret between the Next server and the server: signs the 50s ticket the page presents on `GET /listen`, 32 random bytes. Never with the `NEXT_PUBLIC_` prefix: it must not reach the browser |
| SERVER | `INGEST_IDLE_MS` | ms without audio bytes after which the ingest is dropped and the sessions closed, default 15000 |
| SERVER | `PORT` | server port, default 8000 (most hosts inject it themselves) |
| SERVER | `TARGET_LANGS` | target languages, one session each; the page reads the list from `GET /info` through its own server |
| WEB | `NEXT_PUBLIC_SERVER_URL` | URL of the server the page connects to: `ws://localhost:8000` locally, `wss://...` in production. The `NEXT_PUBLIC_` prefix is mandatory: Next inlines it into the browser bundle at build time |

Locally, `docker compose` loads the SERVER variables into the container and `web/next.config.mjs` reads the WEB one from the same root `.env`.  
In production each host has its own variables (see Deploy).  
The server does not start if the provider key, `INGEST_TOKEN`, `INFO_TOKEN` or `LISTEN_SECRET` is missing: it exits right away with `missing env var <name>` in the logs.  
The client scripts use no variables: provider, URL, token and device are arguments.

### Running locally

```bash
cp .env.example .env          # set the key of the chosen provider, INGEST_TOKEN, INFO_TOKEN and LISTEN_SECRET (openssl rand -hex 32 for each)
docker compose up --build     # server at http://localhost:8000
curl localhost:8000/health    # ok (503 unavailable if the provider key or model does not respond)
curl -H "Authorization: Bearer $INFO_TOKEN" localhost:8000/info    # {"ingest":false,"langs":["en","it"],"listeners":{},"provider":"openai","model":"gpt-realtime-translate","capabilities":{"subtitles":true}}
```

Web page, in another terminal:

```bash
cd web && npm install && npm run dev   # http://localhost:3000, reads NEXT_PUBLIC_SERVER_URL from the root .env
```

Open the page, pick a language, press **Listen**.

<p align="center">
  <img width="480px" src="docs/images/web-example.avif" alt="Web page: language selector, Listen button, subtitles">
</p>

In a real production context, your web page/app must build on the [server API](#server-api) to apply its own integration logic.

ffmpeg audio source in a third terminal:

```bash
client/list-devices.sh                                                   # find the microphone
client/send.sh openai http://localhost:8000/ingest <token> :1            # live from the microphone
client/send-file.sh openai http://localhost:8000/ingest <token> talk.wav # or from a file, in real time
```

The client scripts take everything from arguments: the provider (the same `PROVIDER` as the server: it picks the sample rate ffmpeg produces the audio at, table in `client/_common.sh`), the ingest URL, the same token as `INGEST_TOKEN` on the server, and the device. They read neither environment variables nor the `.env`.  
A ctrl-C on ffmpeg keeps the provider sessions open for another 10 s, so the last sentence is translated in full.

### Finding the microphone

The scripts choose the ffmpeg input based on the operating system they run on (macOS avfoundation, Linux PulseAudio or ALSA, Windows DirectShow).

List the capture devices and pass the value as the fourth argument of `send.sh`:

```bash
client/list-devices.sh
```

```
Audio devices (device = :N, N = index below):
[0] External Microphone
[1] MacBook Pro Microphone
```

```bash
client/send.sh openai http://localhost:8000/ingest <token> :1
```

The format of the value depends on the system and the script prints it: an index like `:1`, a source name or `default`, `hw:1,0`, or `audio=<device name>`.  
Devices change index or name when they are plugged or unplugged: **list them again before an event**.

### Deploy

The server is a Docker image (`server/Dockerfile`) and runs on any container host.

It needs:

- the SERVER variables from the [Configuration](#configuration) section (see `.env.example`)
- HTTPS termination in front, long-lived chunked `POST` requests and WebSocket upgrades passed through without buffering
- healthcheck on `GET /health`: 200 only if the provider key and model respond too (free check, no session opened)

The repository is a monorepo: `server/` and `web/` are deployed as two separate services, each with its own root directory, so a push that touches only one of them rebuilds only that one.
For a step-by-step deploy guide see [Railway for the server side](docs/Railway.md) and [Vercel for the web side](docs/Vercel.md).

Then on the PC with ffmpeg: `client/send.sh <provider> https://<server host>/ingest <token> :1`.  
In production the ingest URL must start with `https://`, otherwise the token travels in the clear.

### Languages

`TARGET_LANGS` on the server is the single source of truth: one session per language, and the web page fills the selector by reading `langs` from `GET /info` at load time, through its own server (`web/app/api/info/route.js`).  
Locally it comes from the root `.env` (loaded by `docker compose`); in production from the host's environment variables.

Language codes depend on the provider; the up-to-date list is in the official documentation:

- **OpenAI**: two-letter ISO 639-1 codes (`en`, `fr`, `it`), see the [Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation).
- **Gemini**: BCP-47 codes, where the two-letter ISO 639-1 ones are valid, see the [Live translation guide](https://ai.google.dev/gemini-api/docs/live-api/live-translate).

A rejected code makes the session setup fail: the server keeps retrying with backoff and that language produces nothing.

## Server API

| Endpoint | Description |
|---|---|
| `POST /ingest` | chunked body of mono PCM16 at the provider's sample rate (OpenAI 24 kHz, Google 16 kHz), header `Authorization: Bearer <INGEST_TOKEN>`. 401 with a wrong token, 409 if an ingest is already active |
| `GET /health` | public, no data: `200 ok` if the server is up and the provider answers a `GET` of the configured model (`models.get`, free: no session, no tokens), otherwise `503 unavailable` with the reason only in the logs |
| `GET /info` | header `Authorization: Bearer <INFO_TOKEN>`, 401 without it. Ingest state, listeners per language, `langs`, `provider`, `model` and `capabilities` (e.g. `{subtitles:true}`, the page hides the subtitles if `false`). Called only server side by the Next route handler, which forwards only `langs` and `capabilities` to the browser |
| `GET /listen?lang=en&ticket=<JWT>` | WebSocket. `ticket` = JWT HS256 signed with `LISTEN_SECRET`, `exp` at most 50s ahead (the page gets one from a Next Server Action at every connection). Closes with `4001` if the ticket is missing, invalid or expired, `4000` if the language is not configured. Binary frames = translated mono PCM16 at 24 kHz. Text frames = JSON `{type:'subtitle'\|'status', ...}` |

## Costs and limits

### Costs

The server opens one session for each language in `TARGET_LANGS` and ffmpeg feeds them continuously, silence included, so the cost of an event is roughly languages × session minutes × provider rate, regardless of the number of listeners.  
The billing unit, however, differs from provider to provider:

- **OpenAI**: bills per minute of audio, see the [gpt-realtime-translate model page](https://developers.openai.com/api/docs/models/gpt-realtime-translate), pricing section.
- **Gemini**: bills per audio token, input and output, with a fixed number of tokens per second of audio; input runs for the whole session, output only while the model speaks. The [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), under the `Live translate` model entry, gives in a note the resulting effective price per minute.

Sessions stay open as long as ffmpeg is connected, even in silence.  
If the connection from the PC dies (unplugged cable, dropped Wi-Fi), the server drops the ingest and closes the sessions after `INGEST_IDLE_MS` without audio bytes, 15s by default; relaunch `client/send.sh` to resume.  
**A hard spending limit on the provider account is the safety net for everything else**.

### Limits

- **Latency**: the audience hears the translation about one second behind the speaker, plus the browser buffer and the network.  
  If the speaker switches language mid-sentence, the model waits for the end of the sentence and the delay rises to several seconds. Values observed with OpenAI and a synthesized voice, not measured with Gemini nor with real voices.
- **Bandwidth**: the translated audio travels uncompressed and every listener receives their own stream, so bandwidth grows linearly with the audience.  
  It has to be sized on two fronts: outbound from the server, where the host may bill the traffic (egress), and inbound in the room, where the Wi-Fi is usually the real constraint.
- **One microphone, one direction only**: the server accepts one audio stream at a time (a second `POST /ingest` gets 409): multiple voices must be mixed **before** ffmpeg.  
  The flow goes only from the speaker to the audience: questions from the floor do not reach the speaker translated. An integration that lets people ask questions in several languages directly from the site or app used to listen to the audio would be useful.
- **Session duration**: each provider closes the session after a maximum time.

   - OpenAI: 60 minutes ([Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) guide; the exact expiry arrives in the `expires_at` field of `session.created`), the server rotates it 5 minutes earlier.
   - Gemini: 15-minute audio session and a connection of about 10, announced by a `goAway` message shortly before closing ([Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)), the server rotates it after 8 minutes or immediately on `goAway`.

   Rotation is transparent (it opens a replacement, moves the audio there, lets the old one finish sending the queued audio and closes it), so events of any length work, but a word spoken exactly at the switch (every ~55 minutes with OpenAI, every ~8 with Gemini) can be lost.  
   If a session drops, it is reopened with exponential backoff.
- **Input sample rate**: depends on the provider.

   - OpenAI accepts only PCM16 at 24 kHz;
   - Google works at 16 kHz as per the Live API documentation.

   Each provider declares the value in the server (`inputSampleRate` variable) and ffmpeg produces it through the table in `client/_common.sh`, selected with the first argument of the scripts.  
   The server **NEVER** resamples: if the two values differ, the translated audio changes speed and pitch with no error in the logs.

   The output is always mono PCM16 at 24 kHz for both.

> [!WARNING]
> As of 11 September 2026 the Google model `gemini-3.5-live-translate-preview`, based on empirical tests, is not to be considered production-ready yet, and not by chance it is still in preview.  
> In several cases the audio generated by Gemini looped on a set of words, even with moments of silence on the microphone.

## Security and privacy

### Security

All three secrets are 32 random bytes (`openssl rand -hex 32`), compared in constant time and never logged.

- `INGEST_TOKEN` is the only protection of `/ingest`.  
   One token per event, rotate it afterwards, treating it like the password of the room mixer.  
   Whoever holds the token can occupy the ingest slot and silence the event (a 409 error is returned, which protects against accidental collisions, not against abuse).
- `INFO_TOKEN` protects `/info`, which exposes the ingest state and the number of listeners per language.  
   It is used only by the backend of whoever integrates the service, calling it server side: in the repository the Next route handler reads it from the environment and forwards only `langs` and `capabilities` to the page.  
   Use a value different from `INGEST_TOKEN`: the two secrets protect different things.
- `LISTEN_SECRET` protects `/listen`: the server accepts only connections carrying a ticket, a JWT (HS256) signed with it by the Next Server Action in `web/app/ticket.js`, valid for 50 s.  
   The browser cannot set headers on the WebSocket handshake, so the ticket travels in the query string: it is consumed within a second of being issued and worthless once expired, so a copy in a proxy log does no harm. The check runs at connection time only; an open stream is not cut when its ticket expires.  
   Today the Server Action hands a ticket to whoever loads the page, so this stops whoever only knows the server host, not whoever has the page. For private events add the gate in `web/app/ticket.js` (event code, login): no gate passed, no ticket, and the server needs no change.  
   Every connection adds bandwidth; the provider cost stays the same.
- The provider key lives only in the server environment, and the server is the only one talking to the provider.

### Privacy

Nothing is stored on the application side.
Audio and subtitles pass through the server in memory and are discarded; there are no files, databases or content logs.  
The only buffer is 10s of audio held while a session is being opened.

The audio is sent to the configured provider for translation.

- **OpenAI**: according to the API data policy, data sent through the API is not used to train the models unless you opt in, and abuse-monitoring logs are kept for up to 30 days (https://developers.openai.com/api/docs/guides/your-data, last checked on 10 September 2026).
- **Gemini**: according to the Gemini API terms, with paid services Google does not use prompts and responses to improve its products and logs them only for a limited period for abuse prevention; with the free tier it does use them to improve its products (https://ai.google.dev/gemini-api/terms, last checked on 11 September 2026).  
  For a real event use a key with billing enabled.

Speakers' voices are personal data: if you use the system at a real event you must inform the participants and choose a legal basis according to your legislation (for example, in Europe, GDPR, AI Act and any other applicable obligations); the transfer to the provider is covered by its data processing terms.

Machine translation: it does not replace professional interpreting in legal, medical or contractual contexts.

## License

MIT, copyright [FAIRFLAI](https://www.fairflai.com).
