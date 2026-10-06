#!/usr/bin/env bash
# Development helper, not part of the userscript.
#
# Builds wasm/h264dec.wasm: FFmpeg's H.264 decoder (libavcodec, C, LGPL 2.1+)
# with the wrapper in h264dec.c, for the hold slideshow's keyframe reel. No
# assembly, no threads, only the h264 decoder; the source tarball is pinned
# by SHA-256 (it is also signed by FFmpeg's release key, FCF986EA15E6E293).
#
#   wasm/build.sh          (emcc on PATH or ~/emsdk; the FFmpeg build is cached in ~/.cache/ibh-wasm)
#
# Inside proot every compiler process is traced and configure crawls (~1.5 s
# a test); a native Termux session with `pkg install emscripten` is far faster:
#   IBH_WASM_CACHE=$PREFIX/tmp/ibh-wasm bash <repo>/wasm/build.sh

set -euo pipefail
FFMPEG=ffmpeg-9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="${IBH_WASM_CACHE:-$HOME/.cache/ibh-wasm}"
JOBS="$(nproc)"

# emcc from emsdk, unless one is on PATH already (Termux's own package, outside proot).
command -v emcc >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$CACHE"
cd "$CACHE"
[ -f "$FFMPEG.tar.xz" ] || curl -sSfLO "https://ffmpeg.org/releases/$FFMPEG.tar.xz"
echo "$SHA256  $FFMPEG.tar.xz" | sha256sum -c --quiet
[ -d "$FFMPEG" ] || tar xf "$FFMPEG.tar.xz"
cd "$FFMPEG"

# Configured once: everything off but the h264 decoder, sized for small.
if [ ! -f ffbuild/config.mak ]; then
  emconfigure ./configure \
    --target-os=none --arch=x86_32 --enable-cross-compile \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --disable-asm --disable-inline-asm --disable-x86asm \
    --disable-everything --enable-decoder=h264 \
    --disable-programs --disable-doc --disable-debug --disable-stripping \
    --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
    --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-runtime-cpudetect --disable-autodetect --enable-small \
    --extra-cflags='-Oz'
fi
emmake make -j"$JOBS" libavcodec/libavcodec.a libavutil/libavutil.a

# The wrapper, linked into a standalone module: no JavaScript glue, the
# userscript instantiates it with a handful of stub imports.
emcc -Oz "$HERE/h264dec.c" -I. libavcodec/libavcodec.a libavutil/libavutil.a \
  -o "$HERE/h264dec.wasm" --no-entry -sSTANDALONE_WASM \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=512MB
ls -l "$HERE/h264dec.wasm"
