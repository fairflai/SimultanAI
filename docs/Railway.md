# Deploy on Railway

This document describes how to deploy the project's server to [Railway](https://railway.com), step by step.

## Prerequisites

A Railway account, the API key of the chosen provider (`GEMINI_API_KEY` or
`OPENAI_API_KEY`) and the repository on GitHub with the code on `main`: Railway
builds only what is pushed there.

## 1. Project

*New Project* → *Empty Project*, then rename it `SimultanAI` or whatever you prefer.

Set the region on the service in Settings → *Region & Replicas*: try to deploy as close as possible to where your event takes place.
The audio round trip already carries the provider's latency; try to keep it to a minimum.

## 2. Server

*+ Create* → **GitHub Repo** → select the repository.
Rename the service `server`.

In **Settings → Source and Build**:

| Field | Value |
|---|---|
| Branch | `main` |
| Root Directory | `server` |
| Builder | **Dockerfile**, chosen by hand |

Dockerfile auto-detection does not kick in once the root directory is set:
select the builder yourself. The path then shows up as
`/server/Dockerfile`, relative to the repository root.

**Settings → Region & Replicas**:

- Region: see above.
- Replicas: **1, never more.** The ingest state and the listeners' WebSocket
  connections live in the process memory. With two replicas the proxy sends
  ffmpeg to one and half of the listeners to the other, which stays silent
  with no error at all.

**Variables:**

Refer to the .env.example file, which has all the useful details.  
Set `PORT=8000` explicitly: it must match the Dockerfile's `EXPOSE 8000` and the target port of the domain (see Networking below).  
Saving the variables triggers a redeploy; without them the container exits with
`missing env var ...` at startup: that is the check, not a failure.

**Settings → Deploy → Healthcheck Path**: `/health`

Railway calls it on every deploy and moves traffic to the new container only
when it answers 200: a broken deploy does not take down the running one.

**Settings → Networking → Generate Domain**, target port **8000**.

That is the container's internal port, not the one in the public URL.  
Public URLs **have no port**: the Railway proxy listens on 443 and forwards
to 8000. `wss://<domain>:8000` does not connect.

**Verification:**

```
https://<domain>/health  →  ok
curl -H "Authorization: Bearer $INFO_TOKEN" https://<domain>/info  →  {"ingest":false,"langs":["en","fr"],"listeners":{},"provider":"google",...}
```

and `listening on :8000, provider google (...), languages en,fr` in the deploy logs.

## 3. End-to-end test

With the web page already deployed (see [Vercel.md](Vercel.md)) and open on a
language. From a PC with ffmpeg, provider name first:

```bash
client/send.sh google https://<domain>/ingest <INGEST_TOKEN> :1
```

Meanwhile:

```bash
curl -s -H "Authorization: Bearer $INFO_TOKEN" https://<domain>/info   →  "ingest":true, "listeners":{"en":1}
```

In the deploy logs: `ingest started from ...` followed by the provider sessions
opening, and **no** `ingest idle for 15000 ms` while ffmpeg is running.
That line within a few seconds of startup would mean the proxy buffers
the POST instead of streaming it.

`Ctrl+C` on ffmpeg: `ingest stopped after ...s` in the logs and `"ingest":false`
from `/info`.

## Resources

| Service | vCPU | RAM | Serverless |
|---|---|---|---|
| `server` | 1 | 512 MB | no during tests; optional afterwards |

The limits are caps, not reservations: billing follows actual usage, so
a low cap saves nothing and a high one costs nothing at rest. The
server is pure I/O: one inbound stream, one provider session per language,
384 kbps outbound per listener. At rest it uses about 60 MB; with 100
listeners it stays under 150 MB. The cap only serves to stop a runaway
process.

Serverless saves the cost at rest. During an event
ffmpeg's POST is continuous inbound traffic, so the service never
sleeps; provider sessions exist only during an ingest, so sleeping loses
nothing.

The only risk is the wake-up: the first `send.sh` of the day may find the
container asleep and ffmpeg waits while it starts. Open the web page first,
its call to `/info` wakes the server, then start ffmpeg. Try a cold
wake-up with ffmpeg before relying on it for an event.
