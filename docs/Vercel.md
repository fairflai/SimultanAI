# Deploy on Vercel

This document describes how to deploy the project's example FE component to [Vercel](https://vercel.com), step by step.

## Prerequisites

A Vercel account, the repository on GitHub with the code on `main` (Vercel
builds only what is pushed there), the Railway domain of the server and
the same `INFO_TOKEN` set there.

## Project

*Add New Project* → select the repository.

| Field | Value |
|---|---|
| Root Directory | `web` (no slash) |
| Framework | Next.js, detected automatically |

**Environment Variables**, to be set **before** the first deploy:

Refer to the .env.example file, which has all the useful details.

```
NEXT_PUBLIC_SERVER_URL=wss://<server domain>
INFO_TOKEN=<same value as on Railway>
```

For `<server domain>` set only the origin, no path and no port: the page adds
`/listen?lang=...` by itself, and its `/api/info` route handler calls
`https://<server domain>/info` with `INFO_TOKEN` (server side, never from the browser).  
`NEXT_PUBLIC_` values are inlined into the bundle at build time, so changing them afterwards requires a *Redeploy*.

## Verification

Open the Vercel URL: the language selector fills up with the server's
`TARGET_LANGS`.

<p align="center">
  <img width="480px" src="images/web-example.avif" alt="Web page: language selector, Listen button, subtitles">
</p>

If it stays empty, the server's `/info` is unreachable from the Next server: check the variable, `wss://`, no port, and that `INFO_TOKEN` matches.

For the full test with ffmpeg and a listener see the end-to-end test in [Railway.md](Railway.md), which you may need to adapt if you use something else.
