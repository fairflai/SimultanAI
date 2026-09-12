#!/usr/bin/env bash
# Simulates a live source from an audio file (wav/mp3/m4a...), in real time (-re).
# Usage: client/send-file.sh <provider> <ingest url> <token> <audio file>
#   provider: the server's PROVIDER (openai | google), picks the sample rate
set -euo pipefail
. "$(dirname "$0")/_common.sh"
USAGE="usage: send-file.sh <provider> <ingest url> <token> <audio file>"
PROVIDER="${1:?$USAGE}"
INGEST_URL="${2:?$USAGE}"
TOKEN="${3:?$USAGE}"
FILE="${4:?$USAGE}"
AUDIO_RATE="$(audio_rate "$PROVIDER")"

exec ffmpeg -hide_banner -loglevel info \
  -re -i "$FILE" \
  -ac 1 -ar "$AUDIO_RATE" -f s16le -flush_packets 1 \
  -headers "Authorization: Bearer ${TOKEN}${CRLF}" \
  -chunked_post 1 -method POST "$INGEST_URL"
