# Sourced by the client scripts. No environment variables and no .env: everything comes from arguments.
# Picks the ffmpeg audio input for the operating system.
case "$(uname -s)" in
  Darwin) AUDIO_INPUT_FORMAT=avfoundation; DEFAULT_DEVICE=:0 ;;
  Linux)
    if command -v pactl >/dev/null 2>&1; then AUDIO_INPUT_FORMAT=pulse; else AUDIO_INPUT_FORMAT=alsa; fi
    DEFAULT_DEVICE=default ;;
  MINGW*|MSYS*|CYGWIN*) AUDIO_INPUT_FORMAT=dshow; DEFAULT_DEVICE= ;;   # dshow needs the device name, see list-devices.sh
  *) echo "unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

# ffmpeg expects CRLF at the end of each header. Built as a variable, never via $(...):
# command substitution strips the trailing \n and leaves a lone \r, which corrupts the request.
CRLF=$'\r\n'

# PCM16 mono sample rate each server provider expects (must match inputSampleRate in server/src/providers/impl/<provider>.js)
audio_rate() {
  case "$1" in
    openai) echo 24000 ;;
    google) echo 16000 ;;
    *) echo "unknown provider '$1', valid values: openai, google" >&2; exit 1 ;;
  esac
}
