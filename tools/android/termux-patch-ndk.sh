#!/data/data/com.termux/files/usr/bin/sh
# Makes an official Android NDK (built for linux-x86_64) usable in native
# Termux on aarch64:
# - its x86_64 tools become links to Termux's own builds; clang becomes a
#   wrapper around Termux's clang (see below);
# - its CMake toolchain accepts Termux's cmake, which reports the host as Android;
# - its sysroot gets a libc++_shared.a, because Termux's clang always names
#   libc++ "c++_shared", even for -static-libstdc++ (AGP's default c++_static);
# - its clang resource dir's headers become Termux's clang's own (a link):
#   builtin headers such as arm_neon.h are generated for one compiler build,
#   and the NDK's (r29: clang 21.0, r563880) declared NEON intrinsics that
#   Termux's clang (21.1.8) rejects with "incompatible constant for this
#   __builtin_neon function" (found 2026-10-18 building mbedtls for
#   arm64-android; no code before had used NEON). The NDK's stay in
#   include.ndk; its libraries (compiler-rt, libunwind) are kept.
# Run it again after installing another NDK, and after Termux's clang changes
# version; what is already patched is skipped.
#
#   termux-patch-ndk.sh [ndk-dir...]   (default: every NDK in ~/android-sdk/ndk)
set -e
[ $# -gt 0 ] || set -- "$HOME"/android-sdk/ndk/*

# Termux's clang, but with the NDK's resource dir (Google's compiler-rt and
# libunwind, for every ABI) and without the rpath into the sysroot that
# Termux's clang adds when linking.
write_clang_wrapper() {
  cat > "$1" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
# Written by termux-patch-ndk.sh: Termux's clang with this NDK's resource dir.
P=/data/data/com.termux/files/usr/bin
case $1 in -cc1*) exec $P/clang "$@" ;; esac
case ${0##*/} in *++) c=clang++ ;; *) c=clang ;; esac
res=$(cd "$(dirname "$0")"/../lib/clang/* && pwd)
link=-fno-termux-rpath
for a; do case $a in -c|-S|-E|-M|-MM) link= ;; esac; done
exec $P/$c -resource-dir "$res" $link "$@"
EOF
  chmod 755 "$1"
}

for ndk; do
  echo "== $ndk"
  # shader-tools: glslc (Termux package shaderc) and spirv-* (spirv-tools), for AGP's shaders feature.
  for bin in "$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin" "$ndk/prebuilt/linux-x86_64/bin" \
             "$ndk/shader-tools/linux-x86_64"; do
    for f in "$bin"/*; do
      name=${f##*/}
      case $name in
        clang-[0-9]*)
          grep -q termux-patch-ndk "$f" 2>/dev/null || { rm -f "$f" && write_clang_wrapper "$f"; }
          continue ;;
      esac
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      [ "$(head -c 4 "$f" | tail -c 3)" = ELF ] || continue
      target=$PREFIX/bin/$name
      if [ -x "$target" ]; then
        rm -f "$f" && ln -s "$target" "$f"
      else
        echo "   no Termux build of $name; left as is (x86_64, won't run)"
      fi
    done
  done
  for tc in "$ndk/build/cmake/android.toolchain.cmake" "$ndk/build/cmake/android-legacy.toolchain.cmake"; do
    grep -q 'STREQUAL Android)' "$tc" ||
      sed -i 's/^if(CMAKE_HOST_SYSTEM_NAME STREQUAL Linux)$/if(CMAKE_HOST_SYSTEM_NAME STREQUAL Linux OR CMAKE_HOST_SYSTEM_NAME STREQUAL Android)/' "$tc"
  done
  termux_headers=$("$PREFIX/bin/clang" -print-resource-dir)/include
  for res in "$ndk"/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*; do
    [ "$(readlink "$res/include")" = "$termux_headers" ] && continue
    [ -d "$res/include" ] && [ ! -L "$res/include" ] && mv "$res/include" "$res/include.ndk"
    rm -f "$res/include"
    ln -s "$termux_headers" "$res/include"
    echo "   $res/include -> $termux_headers"
  done
  for d in "$ndk"/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/*-linux-android*; do
    [ -e "$d/libc++_static.a" ] && [ ! -e "$d/libc++_shared.a" ] &&
      echo 'INPUT(-lc++_static -lc++abi)' > "$d/libc++_shared.a"
  done
done