#!/usr/bin/env bash
# Captures the microphone and streams it to the server as PCM16 mono at the provider's sample rate.
# Usage: client/send.sh <provider> <ingest url> <token> [device]
#   provider: the server's PROVIDER (openai | google | palabra), picks the sample rate
#   device: value printed by client/list-devices.sh, default = first system device
set -euo pipefail
. "$(dirname "$0")/_common.sh"
USAGE="usage: send.sh <provider> <ingest url> <token> [device]"
PROVIDER="${1:?$USAGE}"
INGEST_URL="${2:?$USAGE}"
TOKEN="${3:?$USAGE}"
DEVICE="${4:-$DEFAULT_DEVICE}"
AUDIO_RATE="$(audio_rate "$PROVIDER")"
: "${DEVICE:?device required on this system, run client/list-devices.sh}"

# Railway's proxy closes any request body after 5 minutes: dd cuts the stream into POSTs of at most 4 (2400 x 100 ms),
# the server keeps the provider sessions open between two of them (INGEST_GRACE_MS).
# dd, unlike head, never reads past its block from a pipe: no audio is lost, the pipe holds it while the next POST opens.
# curl -T - streams stdin as it arrives (chunked); --fail ends the script on 401/409 instead of looping
FRAME=$((AUDIO_RATE / 10))
DD_LOG="$(mktemp)"
ffmpeg -hide_banner -loglevel info \
  -f "$AUDIO_INPUT_FORMAT" -i "$DEVICE" \
  -af "aresample=${AUDIO_RATE},asetnsamples=n=${FRAME}" -ac 1 -ar "$AUDIO_RATE" -f s16le -flush_packets 1 - |
while :; do
  dd bs=$((FRAME * 2)) count=2400 2>"$DD_LOG" |
    curl -sS --fail -T - -X POST -H "Authorization: Bearer ${TOKEN}" "$INGEST_URL"
  grep -q '^0+0 records in' "$DD_LOG" && break # ffmpeg exited: dd read nothing
done
