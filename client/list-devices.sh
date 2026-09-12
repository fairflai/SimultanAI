#!/usr/bin/env bash
# Lists the audio input devices ffmpeg can capture on this operating system,
# and shows the value to pass as <device> to client/send.sh.
set -uo pipefail
. "$(dirname "$0")/_common.sh"

case "$AUDIO_INPUT_FORMAT" in
  avfoundation)
    echo "Audio devices (device = :N, N = index below):"
    ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/AVFoundation audio devices/,$p' | grep -oE '\[[0-9]+\] .*' ;;
  pulse)
    echo "PulseAudio / PipeWire sources (device = <name>, or 'default'):"
    pactl list short sources | awk '{print "  " $2}' ;;
  alsa)
    echo "ALSA capture devices (device = hw:<card>,<device>, or 'default'):"
    arecord -l 2>/dev/null | grep '^card' ;;
  dshow)
    echo "DirectShow devices (device = 'audio=<name>'):"
    ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1 | grep -i 'audio' ;;
esac
