---
name: phone-workflow
description: How to test, debug, measure and ship Image Board Helper on the user's phone through the `phone` MCP server (Firefox Beta + Violentmonkey on an Oppo A5, driven from the Fedora container on the same device). Use it whenever the work touches the phone in any way — deploying or installing a new version, "olha o log", "olha a screenshot", a bug the user saw on the phone, a slow or failing hold slideshow or video, a post id to investigate, Wireless debugging or Shizuku being off, Firefox preferences, running a heavy build natively in Termux, or checking the repo before shipping — even when the user does not name the MCP or the tools.
---

# Phone workflow

The userscript only really runs on the user's phone: Firefox Beta with Violentmonkey, on an Oppo A5 (SM6115: four decoders at most, hardware video up to 1920×1088). This container runs on that same phone, and the `phone` MCP server (`tools/phone-mcp.js`) reaches it three ways: Shizuku (`rish`, uid shell), adb over the phone's own Wireless debugging, and Firefox's remote debugger forwarded to tcp:6000. Every tool reconnects by itself, so a dropped session costs one call, not a round of commands.

## The rules, and why

- **It is the phone in the user's hand.** `input`, `open_url`, `deploy` and `firefox_pref` with `set`/`clear` change what they see or how their browser behaves. Use them when the user asked for that, or for the deploy that follows a change they requested. Reading (`tabs`, `script_log`, `screenshot`, `logcat`, `device`) is fine anytime.
- **Never turn Wireless debugging on yourself.** `settings put global adb_wifi_enabled 1` restarts adbd and kills Shizuku. When a tool says it is off, ask the user to switch it on (Developer options → Wireless debugging) and wait.
- **The script's log lives in the page.** Any reload wipes it, and numbers the user just produced are gone. `deploy` saves every site tab's log first; before a manual `reload_tabs`, run `log_snapshot`.
- **The visible tab is the user's.** Reload only hidden tabs; ask the user to refresh the visible one.
- **A hidden tab is not a test bench for video.** Firefox decodes nothing in a background tab, and its timers stall: an `eval` with `await` that waits on `setTimeout` never returns there (`fetch` does). Video tests need Firefox in front.
- **Check the version before debugging.** Half the old "it still doesn't work" reports were a tab on the previous version. `tabs` shows each tab's `__ibh.version`.

## Connection trouble

Start with `status`; it reads everything without changing anything.

| What `status` or a tool says | What it means | What to do |
|---|---|---|
| Wireless debugging off / not advertised | the user's toggle is off, or Android turned it off | ask the user to turn it on, then retry |
| Shizuku not running | Shizuku's server died | ask the user to start it in the Shizuku app; adb still works meanwhile |
| a first `rish` call fails, the next works | ColorOS froze Shizuku's idle process ("Async freezing" in logcat) | nothing: the tools already ask twice |
| Firefox debugger not reachable | the forward is gone | any Firefox tool redoes it; `connect force=true` to insist |
| no tabs | Firefox unloaded its tabs (memory) or is closed | ask the user to open the site; the log of unloaded tabs is lost |

## Shipping a change

The project rules (CLAUDE.md) come first: version in both places, CHANGELOG entry, both READMEs, `npm run check`. Then:

1. Commit and push: the raw link is pinned to the commit, so the commit must be on GitHub.
2. `deploy`. It runs `check`, saves every site tab's log, copies the file to `/sdcard/Download`, opens the commit-pinned raw link in Firefox Beta and watches Violentmonkey, then reloads the hidden site tabs. Its report lists the saved logs' key lines: read them, they are the last chance.
3. Violentmonkey updates silently, except when the grants or `@resource` change: then it waits for a tap. Tell the user to tap it; `confirm: true` clicks it only when they asked.
4. `tabs` to see the new version; the visible tab updates when the user refreshes it.

`deploy dry_run=true` checks the whole chain without touching the phone.

## A bug the user saw

1. `tabs`: the right version in the tab they used?
2. `script_log` with a `filter` (a word from the feature, or `error|warn`) and `levels`. Log lines are English on purpose; the panel's **Copiar log** is the same buffer.
3. "Olha a screenshot" means `latest_screenshot` (their own, in `/sdcard/Pictures/Screenshots`); `screenshot` grabs the screen now. For something that moves (a slideshow, a swipe), `screen_record` returns a contact sheet of a few seconds.
4. Outside the page (an app that did not open, a crash): `logcat` with a filter such as `ActivityTaskManager|AndroidRuntime` and `since_s`. `apps url=<link>` says which apps would take an intent.
5. Reproducing a gesture yourself (`input long_press`, `tap`) needs the user's go-ahead and a screenshot first to know the coordinates.

## The hold slideshow and videos

The hold slideshow reads the MP4's index and one keyframe per scene (Range reads), then decodes them in WebAssembly (FFmpeg's H.264, `wasm/`) into a canvas, or plays a small MP4 in a `<video>` without it. Each hold logs one `slideshow (…)` line.

- `slideshow_stats` turns those lines into a table with medians per method (`saved=true` adds the logs saved by deploys). Watch for "lifted before the first scene": the user gave up waiting, which is the number that matters most.
- `video_info post=<id>` reads only the index (a few hundred KB at most) and tells the codec, resolution, fps, bitrate, keyframe count and spacing, whether it fits the hardware decoder, and what a hold will do with it, by the script's own rules (it reuses the script's MP4 reader).
- `reel_preview post=<id>` decodes the keyframes a hold would show with the same WebAssembly decoder, here in Node, and returns them as one contact sheet with each frame's decode time. The pictures are the site's content: describe them only as far as the question needs.

How to read the outcomes: few keyframes and a short clip → it plays at 2×; few keyframes and a long video → it seeks (slow, about a second a scene); past 1920×1088 → always a reel, decoded on the CPU; not H.264 (WebM, HEVC) → the `<video>` reel or seeking.

## Native Termux

proot traces every process, which makes heavy builds crawl: FFmpeg's `configure` takes about 15 minutes in proot and a fraction of that natively. Termux's `~/.zshrc` starts a detached tmux session `ibh` in every native shell, and its socket is shared with the container.

- `termux_run command=… name=…` runs it natively in a new window of that session (Termux's own packages on PATH, `emcc` included); `wait_s` waits for short ones. `termux_job id=…` gives the state and output; no id lists recent jobs. The user can watch with `tmux attach -t ibh` in a Termux session.
- `status` says whether the session is up; if not, any new native Termux session starts it (or the user runs `tmux new -d -s ibh` there).
- Real Termux sessions in the drawer are not available: this Termux build runs no termux-am socket server, and Android refuses `am` to apps.
- `wasm_build` builds `wasm/h264dec.wasm` (natively when possible) and, asked again with `job=…`, copies a successful native build into `wasm/`. Then: commit the `.wasm` first, put that commit in the `@resource h264dec` link, commit again.

## Firefox preferences

`firefox_pref name=…` reads any about:config preference through the debugger, even though Firefox locks about:config on release builds. `set` and `clear` persist across restarts: only on request, and say that `clear` undoes it. Already learned: `dom.media.webcodecs.enabled=true` exposes WebCodecs on Android but every codec answers unsupported, so it is no way around the decoder.

## Checks

- `check`: `npm run check` (syntax, I18N parity, ESLint, TypeScript); about 20 seconds. `deploy` runs it.
- `smoke`: the Playwright test in a headless Firefox on safebooru (rule34 answers headless browsers with a CAPTCHA). About a minute and heavy on memory: Shizuku dropped and Firefox unloaded its tabs once while it ran, so not while the user is in the middle of something.
