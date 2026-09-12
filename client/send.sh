#!/usr/bin/env bash
# Captures the microphone and streams it to the server as PCM16 mono at the provider's sample rate.
# Usage: client/send.sh <provider> <ingest url> <token> [device]
#   provider: the server's PROVIDER (openai | google), picks the sample rate
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

exec ffmpeg -hide_banner -loglevel info \
  -f "$AUDIO_INPUT_FORMAT" -i "$DEVICE" \
  -ac 1 -ar "$AUDIO_RATE" -f s16le -flush_packets 1 \
  -headers "Authorization: Bearer ${TOKEN}${CRLF}" \
  -chunked_post 1 -method POST "$INGEST_URL"
