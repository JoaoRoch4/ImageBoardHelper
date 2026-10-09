# Video Reducer Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Booru videos past the phone's hardware decoder play converted in IBH's modal, through VideoReducer's `vreduce` run by the phone server.

**Architecture:** The phone server (native Termux, `127.0.0.1:8730`) gains the routes of VideoReducer's HTTP contract in a module of its own, `tools/video-reducer.mts`, wired in by a small router; the userscript asks it through `GM_xmlhttpRequest` and swaps the `<video>` source to the growing file at `/v/<key>.mp4`. A Termux:Widget task starts the server and copies its token.

**Tech Stack:** Node 26 native / Node 24 container, TypeScript stripped by Node (`tools/*.mts`, `tsc -p tools` strict), `node:test`; the userscript (ES2020, one file, no build); Playwright smoke (`tools/smoke.js`).

**Spec:** `docs/superpowers/specs/2026-10-09-video-reducer-integration-design.md`, which builds on `/root/VideoReducer/docs/superpowers/specs/2026-10-08-videoreducer-design.md` (the contract: read its "HTTP contract", "Cache", "Heat and battery", "Log" and "Failure behaviour" sections before tasks 2–4).

## Global Constraints

- Userscript rules (CLAUDE.md): every new feature has a `DEFAULTS` key, a panel entry, a log line (English), both `I18N` tables with the same keys, both READMEs; `@version` and `const VERSION` move together with a CHANGELOG entry. This work ships as **1.14.0**.
- `DEFAULTS.videoReducer` is `false`: with it off the script sends no request to `127.0.0.1`.
- The token is read and written only with `GM_getValue`/`GM_setValue` (key `reducerToken`), never through `storeGet`/`storeSet` (which fall back to the site's IndexedDB) and never in `IBH_CFG`.
- Tools: only syntax Node can strip (no `enum`), `import type` for types, import paths with the extension, no runtime dependencies; `npm run check` must pass (`tsc -p tools` has `noUncheckedIndexedAccess` and `noUnusedLocals`).
- Server: the phone server's `VERSION` becomes `2.0.0`; every route needs the Bearer token except `GET /v/<key>.mp4`; no CORS headers anywhere.
- `POST /video/reduce` accepts only `https:` URLs on rule34.xxx, gelbooru.com, safebooru.org, xbooru.com or their subdomains.
- Values copied from the contract: poll every 1.5 s from the script; interest timeout 30 s; one job at a time; priorities `open` > `next` > `batch`; `playable` when done or `pos ≥ 1.2 × dur × (1 − speed) + 2` with `speed` averaged over the last 5 s; cache `~/.cache/vreduce/`, SHA-256 of the URL, `<hash>.part.mp4` renamed to `<hash>.mp4`, LRU 2 GB trimmed before each job; `/v/` key 32 random bytes in hex; a range past the written end waits up to 30 s; every `/v/` answer has `Cross-Origin-Resource-Policy: cross-origin`; heat 42 °C / 45 °C, battery 20 %; SIGTERM then SIGKILL after 5 s.
- Test environment variables (all optional, defaults in parentheses): `VREDUCE` (the rootfs path to `/root/VideoReducer/build/vreduce`), `IBH_VREDUCE_CACHE` (`<Termux home>/.cache/vreduce`), `IBH_VREDUCE_CACHE_MB` (2048), `IBH_VIDEO_INTEREST_MS` (30000), `IBH_VIDEO_BATTERY_MS` (30000), `IBH_VIDEO_WARM_C` (42), `IBH_VIDEO_HOT_C` (45), `IBH_VIDEO_LOW_BATTERY` (20), `IBH_VIDEO_RANGE_WAIT_MS` (30000), `IBH_TERMUX_PREFIX` (`/data/data/com.termux/files/usr`), `IBH_TERMUX_HOME` (exists already).
- Commit on `main` after each task, with the attribution lines the session asks for.

## Review Focus

1. **Swiping on while a conversion runs:** the old post's polling must stop and a late `playable` must never swap the source of the post now on screen (Task 7 test "a late playable does not touch another post").
2. **The server restarted mid-job** (`GET /video/<id>` answers 404): one retry, then the original video stays with a toast (Task 8 test "unknown id after a retry falls back").
3. **No Violentmonkey storage:** the token field is disabled and nothing is stored anywhere (Task 6 test "no GM storage: no token kept").
4. **Range requests on a growing file:** `bytes=N-` inside the written part, past it (waits, then 416 after the wait), and on the finished file (`bytes a-b/size`) (Task 4 tests).
5. **A conversion cancelled by another tab** (the newest `open` wins): the first tab sees `cancelled`, puts ⚡ back and keeps the original (Task 8 test "cancelled by another tab").

---

### Task 0: Spike 2, the way into Firefox (with the user)

Needs the user with Firefox Nightly in front. No product code; the result decides Task 9.

**Files:**
- Create: `docs/spikes/2026-10-09-localhost-media.md` (findings)

- [ ] **Step 1: Make a growing-file source.** Natively (phone MCP `termux_run`, or the tmux helper): a fragmented MP4 from Termux's ffmpeg, `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 20 -c:v libx264 -g 30 -movflags frag_keyframe+empty_moov+default_base_moof /sdcard/Download/spike.mp4`, then `python3 /root/VideoReducer/tests/fixture_server.py` in its growing mode on port 8731 (read its `--help` for the flag) serving that file.
- [ ] **Step 2: Ask the user to open a rule34 post in Nightly**, then with the phone MCP `eval` (await) in that tab: create a `<video muted autoplay>` with `src = http://127.0.0.1:8731/<path>`, append it, and after 10 s read `readyState`, `currentTime`, `duration`, `error`, `getVideoPlaybackQuality()`, and `performance.getEntriesByName(src)`. Take a `screenshot` to see any permission prompt.
- [ ] **Step 3: Leave `GM_xmlhttpRequest`'s latency to `127.0.0.1` for Task 10's device run** (the userscript's sandbox is not reachable from `eval`); note it as pending in the findings.
- [ ] **Step 4: Write the findings** (plays or not, prompt or not, stall-not-ended at the written end, dropped frames, latency) in the spikes file. Decision line at the end: `Task 9: needed` or `Task 9: not needed`.
- [ ] **Step 5: Commit** `docs/spikes/2026-10-09-localhost-media.md`.

### Task 1: Server core split and the router

**Files:**
- Create: `tools/http-error.mts`
- Create: `tools/video-reducer.mts` (skeleton, filled by tasks 2–4)
- Modify: `tools/phone-server.mts` (imports, `serve()` dispatch, `VERSION`)
- Test: `tools/phone-server.test.mts`, `tools/video-reducer.test.mts` (new)

**Interfaces:**
- Produces, `tools/http-error.mts`:
  - `export class HttpError extends Error { status: number }` (moved from `phone-server.mts`, which re-exports it)
  - `export type Handler = (body: Record<string, unknown>) => Promise<Record<string, unknown>>`
- Produces, `tools/video-reducer.mts`:
  - `export interface VideoDeps { termux(name: string, args: string[]): Promise<string>; dir: string; mediaDir: string; notify(title: string, text: string): Promise<void> }`
  - `export function makeVideoReducer(deps: VideoDeps): { routes: Record<string, Handler>; serveMedia(req: http.IncomingMessage, res: http.ServerResponse): void; stop(): void }`
  - route names: `video/reduce`, `video/status`, `video/cancel`, `video/save`, `video/batch`
- `serve()` dispatch order: `GET /v/…` → `serveMedia` (no token); token check; `GET /video/<id>` → `routes['video/status']({ id })`; otherwise today's `POST /<route>` with the merged table `{ ...ROUTES, ...video.routes }`.

- [ ] **Step 1: Write the failing tests** in `tools/phone-server.test.mts`:

```ts
test('GET /v/<unknown key>: 404 without a token', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v/${'0'.repeat(64)}.mp4`)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin')
})
test('GET /video/<id> needs the token', async () => assert.equal((await req('video/abc', undefined, '')).status, 401))
test('GET /video/<unknown id>: 404', async () => assert.equal((await req('video/abc')).status, 404))
test('status reports version 2.0.0', async () => assert.equal((await req('status')).json.version, '2.0.0'))
```

- [ ] **Step 2: Run `node --test tools/phone-server.test.mts`**; expected: the four new tests FAIL (404 route names, version 1.0.0).
- [ ] **Step 3: Implement** the split, the skeleton (`video/status` throws `HttpError(404, 'no such video')`, `serveMedia` answers 404 with the CORP header), the dispatch above, `VERSION = '2.0.0'`. The server passes `deps` built from its own `termux`, `DIR`, `MEDIA` and a `notify` wrapping `termux-notification`.
- [ ] **Step 4: Run `npm run -s test:tools` and `npx tsc -p tools`**; expected: all pass, no type errors.
- [ ] **Step 5: Commit** "phone server 2.0.0: router for GET and /v/, video reducer module".

### Task 2: Jobs, queue, cache, running `vreduce`

**Files:**
- Modify: `tools/video-reducer.mts`
- Create: `tools/fixtures/fake-vreduce.mts` (the test double, run by Node)
- Test: `tools/video-reducer.test.mts` (starts its own server like `phone-server.test.mts`, with `VREDUCE` pointing at a wrapper script that runs `node tools/fixtures/fake-vreduce.mts "$@"`)

**Interfaces:**
- Consumes: Task 1's `makeVideoReducer`, `HttpError`.
- Produces (answers, as the contract):
  - `video/reduce {url, referer, priority?: 'open'|'next', start?: boolean}` → `{id, state, stream}`; `start: false` with no job and no cache → `{state: 'none'}`
  - `video/status {id}` → `{id, state, playable, pos, dur, speed, eta_s, stream, hot?, error?, stage?, http?}`
  - `video/cancel {id}` → `{}`
  - `id`: first 16 hex digits of the URL's SHA-256; `stream`: `/v/<key>.mp4` (path only; the script prefixes `http://127.0.0.1:8730`)
- The fake `vreduce` reads `FAKE_VREDUCE` (`ok` | `slow` | `fail-input` | `fail-encode`), writes `--out` growing by 64 KB a tick (100 ms; `slow`: 1 s), prints `{"pos","dur":10,"speed","fps","skip":"none","bytes"}` each tick with `speed` 0.8, ends with `{"done":true,…}` and exit 0 after 10 ticks; `fail-*` print `{"error":"…","stage":"input"|"encode","http":403}` after 3 ticks and exit 1; SIGTERM → exit 143 with no final line.

- [ ] **Step 1: Write the failing tests:**
  - `reduce starts a job and status follows it to done` — `state` goes `running` → `done`, `playable` true at the end, `<hash>.mp4` exists in the cache and `<hash>.part.mp4` does not.
  - `the same url gives the same id` (while running and once cached).
  - `start: false finds nothing, then finds the cached file` — first `{state: 'none'}`, after a finished job `{state: 'done'}`.
  - `a non-booru url is refused: 400` — `https://example.com/a.mp4` and `http://rule34.xxx/a.mp4`.
  - `one job at a time; a newer open cancels the older open` — job A `running`, reduce B (`open`) → A `cancelled`, its `.part` deleted, B `running`.
  - `next waits behind open; asking again as open promotes it` — no restart: B's `pos` keeps growing.
  - `a job not polled for the interest time is cancelled` — with `IBH_VIDEO_INTEREST_MS=500`.
  - `a failed vreduce: failed with stage and http` — `FAKE_VREDUCE=fail-input` → `{state: 'failed', stage: 'input', http: 403}`.
  - `cancel stops the process` — `video/cancel` → `cancelled` within 1 s; the fake saw SIGTERM.
  - `.part files are deleted when the server starts`.
  - `the cache is trimmed by last use before a job starts` — `IBH_VREDUCE_CACHE_MB=1` with two old 1 MB files: the older goes.
- [ ] **Step 2: Run `node --test tools/video-reducer.test.mts`**; expected: FAIL.
- [ ] **Step 3: Implement** in `tools/video-reducer.mts`: a `Map<id, VideoJob>`, the queue picker (highest priority, then oldest), `spawn(VREDUCE, ['stream','--url',url,'--referer',referer,'--out',part], { detached: true })` read with `readline`; on exit 0 with a `done` line rename `part` → `file`; `playable(job)` per the contract formula with a 5 s window of `speed` samples; `eta_s` = seconds until that holds at the current speed (0 when playable). Stop = `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` after 5 s.
- [ ] **Step 4: Run the tests**; expected: PASS. Also `npm run -s test:tools`.
- [ ] **Step 5: Commit** "video reducer: jobs, queue, cache and vreduce".

### Task 3: Heat and battery, save, batch, `video.log`

**Files:**
- Modify: `tools/video-reducer.mts`
- Test: `tools/video-reducer.test.mts`

**Interfaces:**
- Consumes: `deps.termux('termux-battery-status', [])` → JSON `{temperature, percentage, plugged}`; `deps.notify`.
- Produces: `video/save {id, name}` (name `^[\w.-]{1,80}$`) → `{saved: true}` or `{saved: false, later: true}`; `video/batch {paths: string[]}` → `{queued: string[]}`; `GET /video/<id>` gains `hot: true` above the hot threshold; `video.log` lines.

- [ ] **Step 1: Write the failing tests** (fake `termux-battery-status` via `IBH_TERMUX_BIN`, printing a temperature from a file the test writes):
  - `above 45 °C nothing runs and status says hot`.
  - `above 42 °C next and batch wait, open goes on`.
  - `below 20 % and not plugged, next waits`.
  - `save of a finished job copies to the media folder and notifies` — file `<IBH_SERVER_MEDIA>/<name>.mp4`; `calls.log` has `termux-notification`.
  - `save before done answers later, then copies at the end; the job outlives the interest time`.
  - `a bad save name: 400` — `../x`, `a b`.
  - `batch queues files without a .1080p sibling and writes <name>.1080p.mp4 next to them` (fake `vreduce file` mode: `FAKE_VREDUCE=ok` handles `file IN OUT` too; the batch runs `vreduce probe` first only if the fake answers `{"fits":false}`).
  - `video.log has start and done lines without the url` — the line has the hash's first 8 digits and no `https://`.
- [ ] **Step 2: Run the tests**; expected: FAIL.
- [ ] **Step 3: Implement**: battery read before each job and every `IBH_VIDEO_BATTERY_MS`; the picker skips by priority under the thresholds; `saveAs` on the job (keeps it past the interest timeout); copy with `fs.copyFile` then `deps.notify('Image Board Helper', '<name>.mp4 saved in Download')`; batch jobs at `batch` priority with output beside the source; `video.log` in `deps.dir`, one line per event (`start`, `playable`, `done`, `cancel`, `fail <stage>`) with hash prefix, size, fps, duration, speed, skip and temperature.
- [ ] **Step 4: Run the tests**; expected: PASS.
- [ ] **Step 5: Commit** "video reducer: heat and battery, save, batch, video.log".

### Task 4: `/v/<key>.mp4`, the growing file over HTTP

**Files:**
- Modify: `tools/video-reducer.mts` (`serveMedia`)
- Test: `tools/video-reducer.test.mts`

**Interfaces:**
- Consumes: the job's `key`, `part`/`file`, and whether it is still running.
- Produces: the contract's `/v/` semantics.

- [ ] **Step 1: Write the failing tests** (`FAKE_VREDUCE=slow`, so the file grows for 10 s):
  - `no token needed; a wrong key is 404` (with CORP).
  - `while growing, bytes=N- inside the written part: 206 with bytes a-b/*`.
  - `while growing, a range past the end waits for data` — request `bytes=<written+1000>-` resolves with 206 once the file passes it.
  - `a range past the end of a growing file gets 416 after the wait` — `IBH_VIDEO_RANGE_WAIT_MS=300`, cancel the job right after asking.
  - `finished: ordinary ranges with the size` — `Content-Range: bytes 0-99/<size>`, 206; no Range → 200 with `Content-Length`.
  - `no Range while growing: 200 chunked, following the file to the end` — the body length equals the final file size.
  - `every answer has CORP and Content-Type video/mp4`.
- [ ] **Step 2: Run the tests**; expected: FAIL.
- [ ] **Step 3: Implement** `serveMedia` with `fs.createReadStream({start, end})` on the written part, polling the size every 200 ms while waiting or following.
- [ ] **Step 4: Run the tests**; expected: PASS; then `npm run -s check`.
- [ ] **Step 5: Commit** "video reducer: /v/ serves the growing file".

### Task 5: The Termux shortcut and command

**Files:**
- Modify: `tools/phone-server.mts` (`install-shortcuts`, shared start lines with `install-boot`)
- Create: `tools/assets/ibh-servidor.png` (192×192 icon, made once with Pillow in the container and committed)
- Test: `tools/phone-server.test.mts`

**Interfaces:**
- Produces: `node tools/phone-server.mts install-shortcuts` writes `<IBH_TERMUX_HOME>/.shortcuts/tasks/IBH servidor` (mode 755), `<IBH_TERMUX_PREFIX>/bin/ibh-servidor` (a symlink to it), `<IBH_TERMUX_HOME>/.shortcuts/icons/IBH servidor.png`; `function startLines(native: string): string[]` shared with `installBoot` (wake lock, `tmux has-session || tmux new-session -d -s ibh`, the `server` window).
- The script, in order: `termux-wake-lock`; the session; `curl -fsS -m 2 -H "Authorization: Bearer $(cat <token file>)" http://127.0.0.1:8730/status` — if it fails, the server window, then up to 10 tries 1 s apart; `termux-clipboard-set < <token file>`; `termux-toast "IBH server on · token copied"` or `"IBH server already on · token copied"`, or `"IBH server did not start"` after 10 failed tries.

- [ ] **Step 1: Write the failing tests:**
  - `install-shortcuts writes the task, the command link and the icon` (paths and modes, the link's target).
  - `the shortcut starts the server when it does not answer` — run `sh "<task>"` with a `PATH` of stubs: `curl` failing on its first call and succeeding after, `tmux` (has-session fails), `termux-wake-lock`, `termux-clipboard-set`, `termux-toast`; `calls.log` must have `tmux new-session -d -s ibh`, a `tmux new-window … -n server …`, `termux-clipboard-set`, and `termux-toast IBH server on · token copied`.
  - `the shortcut leaves a running server alone` — `curl` succeeds at once: no `new-window`, toast `IBH server already on · token copied`.
- [ ] **Step 2: Run the tests**; expected: FAIL.
- [ ] **Step 3: Implement** `installShortcuts()` and `startLines()`; the usage line lists `install-shortcuts`.
- [ ] **Step 4: Run the tests**; expected: PASS.
- [ ] **Step 5: Install on the phone** (the user asked for it): `node tools/phone-server.mts install-shortcuts` run in the container (it writes through the shared paths) and check the files natively; then `server_control restart` so the server runs 2.0.0.
- [ ] **Step 6: Commit** "phone server: IBH servidor shortcut and command".

### Task 6: Userscript, the option, the token and the status

**Files:**
- Modify: `image-board-helper.user.js` (`DEFAULTS`, `I18N` ×2, a new "Video reducer" block in section E near the downloads, panel in `buildPanel`)
- Modify: `tools/smoke.js`

**Interfaces:**
- Produces:
  - `DEFAULTS.videoReducer: false`
  - `const REDUCER = 'http://127.0.0.1:8730'`
  - `reducerToken(): string` (`GM_STORE ? GM_getValue('reducerToken', '') : ''`) and `setReducerToken(value: string): void` (no-op without `GM_STORE`)
  - `reducerCall(method: 'GET' | 'POST', route: string, body?: object): Promise<{ ok: boolean, status: number, json: any, stage?: string, error?: string }>` — `GM_xmlhttpRequest` with the Bearer token, 10 s timeout; network failure → `{ok: false, stage: 'server', error: 'not answering'}`; 401 → `stage: 'token'`
  - `I18N` keys (both tables): `tReducer`, `reducerToken`, `reducerOk`, `reducerDown`, `reducerBadToken`, `reducerNoStore`
- Panel: a toggle `videoReducer`; when on, a password field (`autocomplete="off"`) bound to the token and a status row from `reducerCall('GET', 'status')` each time the panel opens: `reducerOk` with the server's version, `reducerDown`, or `reducerBadToken`.

- [ ] **Step 1: Write the failing smoke checks** in `tools/smoke.js` (GM stub already in memory): 
  - `reducer off: no requests to 127.0.0.1` — wrap `window.GM_xmlhttpRequest` to record URLs; open and close the modal; none starts with `http://127.0.0.1`.
  - `token kept in GM only` — set `videoReducer` on via `__ibh.set`, type `abc123` in the panel's token field; `GM_getValue('reducerToken')` is `abc123` and neither `localStorage` nor `IBH_CFG` contains it.
  - `no GM storage: no token kept` — in a second page with `GM_setValue` removed from the stub, the field is disabled and shows `reducerNoStore`.
- [ ] **Step 2: Run `node tools/smoke.js`** (safebooru); expected: the new checks FAIL.
- [ ] **Step 3: Implement** as in Interfaces; log `video reducer: server <version>` / `video reducer: server <stage> <error>` when the status row is drawn.
- [ ] **Step 4: Run the smoke and `npm run -s check`**; expected: PASS.
- [ ] **Step 5: Commit** "video reducer in the script: option, token, status".

### Task 7: ⚡ Convert, progress and the swap

**Files:**
- Modify: `image-board-helper.user.js` (sheet button, player warning spot in `showVideo`, `installVideoControls` duration override, polling)
- Modify: `tools/smoke.js` (a fake server; runs on a video listing)

**Interfaces:**
- Consumes: Task 6's `reducerCall`, `reducerToken`; existing `pastDecoder(w, h)`, `modal.fileUrl`, `modal.seq`, `applyPlayRate(video)`, `flash`.
- Produces:
  - `modal.reduceBtn` (sheet, `class: 'pill'`) and `modal.reduceBig` (player, `class: 'reducebig'`, in place of the `bigVideo` flash when `pastDecoder` and the option is on)
  - `modal.reduceJob: { id: string, state: string } | null` — the post's job, cleared on every post change (`resetMedia`)
  - `startReduce(): Promise<void>`, `pollReduce(id: string, seq: number): void`, `swapToReduced(stream: string, dur: number): void`
  - `installVideoControls(...)` returns also `setDuration(seconds: number | null): void`; with a duration set, the times and the seek bar use it, and a seek past the end of `buffered` stops there
  - `I18N` keys: `reduceBtn` ("⚡ Convert"), `reduceProgress` ("⚡ {pct}% · ~{eta} s"), `reduceQueued`, `reduceHot`, `reduceReady`
- Behaviour: on post open with the option on, `reducerCall('POST', 'video/reduce', {url, referer, start: false})`: `running` → polling; `done` → `swapToReduced`. Tap → same call with `priority: 'open'`. Poll `GET video/<id>` every 1500 ms while `modal.seq === seq`; `playable` → swap once. Swap keeps time (if within the written part), paused/playing and speed. A waiting badge shows while `currentTime` has not moved for 1 s within 0.5 s of the `buffered` end and the video is not paused.

- [ ] **Step 1: Write the failing smoke checks**, active when the modal shows a video (`SKIP` otherwise); run with `node tools/smoke.js 'https://gelbooru.com/index.php?page=post&s=list&tags=video'`. The fake server: `window.GM_xmlhttpRequest` answers `POST …/video/reduce` (`start:false` → `{ok:true,state:'none'}`, else `{ok:true,id:'j1',state:'running',stream:'/v/'+'a'.repeat(64)+'.mp4'}`) and `GET …/video/j1` (first `{state:'running',pos:2,dur:10,eta_s:6,playable:false}`, then `playable:true`); `page.route('http://127.0.0.1:8730/v/**')` fulfills with `route.fetch` of the post's own file.
  - `convert shows in the sheet and its progress` — after the tap the button reads `⚡ 20% · ~6 s`.
  - `playable swaps the source` — `video.currentSrc` is `http://127.0.0.1:8730/v/aaa…a.mp4`.
  - `the times use the server's duration` — the second `.vtime` reads `0:10`.
  - `a late playable does not touch another post` — tap, step to the next post, then let `j1` turn playable: the video's source is not the `/v/` URL.
  - `past the decoder the player offers convert` — on the modal video, `Object.defineProperty` `videoWidth` 2560 / `videoHeight` 1440 and dispatch `loadedmetadata`: `.reducebig` is visible and no `bigVideo` toast.
- [ ] **Step 2: Run that smoke**; expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; logs `video reducer: post <id> converting`, `… playable after <s> s, swapped at <t>`.
- [ ] **Step 4: Run the smoke (gelbooru video listing and safebooru) and `npm run -s check`**; expected: PASS.
- [ ] **Step 5: Commit** "video reducer in the script: convert, progress, swap".

### Task 8: ⬇ Download 1080p and the failures

**Files:**
- Modify: `image-board-helper.user.js`
- Modify: `tools/smoke.js`

**Interfaces:**
- Consumes: Task 7's job state (`modal.reduceJob = { id, state }`).
- Produces: `modal.dl1080Btn` in the sheet (visible while `modal.reduceJob` is set); `saveReduced(): Promise<void>` → `reducerCall('POST', 'video/save', { id, name: '<site>_<post>.1080p' })`; `I18N` keys `dl1080Btn`, `dl1080Saved`, `dl1080Later`, `reduceFailed`, `reduceCancelled`.
- Failure handling in one place, `reduceFailed(stage: string, error: string)`: toast `reduceFailed`, log `video reducer: <stage> <error>`, ⚡ shows "failed" 3 s then comes back, the original video stays.

- [ ] **Step 1: Write the failing smoke checks** (same fake server, extended):
  - `download 1080p asks the server to save` — recorded body `{id:'j1', name:'gelbooru_<post>.1080p'}`; toast `dl1080Later` when the fake answers `{saved:false,later:true}`.
  - `a failed job keeps the original and says so` — status `{state:'failed',stage:'input',http:403}`: source unchanged, log line `video reducer: input`.
  - `unknown id after a retry falls back` — status answers 404 twice: same as above with stage `server`.
  - `cancelled by another tab` — status `{state:'cancelled'}`: ⚡ back, original kept, toast `reduceCancelled`.
- [ ] **Step 2: Run the smoke**; expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the smokes and `npm run -s check`**; expected: PASS.
- [ ] **Step 5: Commit** "video reducer in the script: download 1080p, failures".

### Task 9: `MediaSource` delivery (only if Task 0 says `needed`)

**Files:**
- Modify: `image-board-helper.user.js` (`swapToReduced` picks the delivery)

**Interfaces:**
- Produces: `feedMediaSource(video: HTMLVideoElement, stream: string, dur: number): () => void` (returns a stop function): a `MediaSource` with one `SourceBuffer` (`video/mp4; codecs="avc1.640029, mp4a.40.2"` or the codecs read from the first `moov`), `GM_xmlhttpRequest` range reads of `REDUCER + stream` 1 MB at a time, appended in order, waiting for the file to grow; `endOfStream()` once the job is done and the last range is in.

- [ ] **Step 1: Write the failing smoke check** `MediaSource delivery appends the stream` — with a flag `__ibh.set('reducerMse', true)` forcing it, the video's `src` is a `blob:` URL and `buffered.end(0) > 0` after the fake range answers.
- [ ] **Step 2: Run**; expected: FAIL. **Step 3: Implement.** **Step 4: Run**; expected: PASS. **Step 5: Commit** "video reducer: MediaSource delivery".

### Task 10: Docs, version, device run, deploy

**Files:**
- Modify: `image-board-helper.user.js` (`@version` and `VERSION` 1.14.0), `CHANGELOG.md`, `README.md`, `README.pt-BR.md` (a `videoReducer` row; the server and shortcut in a short section), `CLAUDE.md` (server routes and module, the shortcut, the tmux-0 lesson in "Armadilhas já pagas", open tasks), `.claude/skills/phone-workflow/SKILL.md` (video routes, `install-shortcuts`), `docs/superpowers/specs/2026-10-07-phone-server-design.md` (part 2 done)

- [ ] **Step 1: Write the docs and bump the versions.**
- [ ] **Step 2: Run `npm run -s check` and the smokes** (safebooru, gelbooru, xbooru, gelbooru video listing); expected: all pass.
- [ ] **Step 3: Commit and push**, then phone MCP `deploy`.
- [ ] **Step 4: Device run with the user** (Nightly in front): tap the IBH servidor icon (toast, token on the clipboard), paste the token in the panel (status "connected 2.0.0"), open a post past 1080p60, tap ⚡, watch the progress, the swap, playback without dropped frames (`getVideoPlaybackQuality`), ⬇ Download 1080p (file in Download, notification). Read `video.log`.
- [ ] **Step 5: Record the device numbers** (time to playable, speed, dropped frames) in CLAUDE.md and close the open task.
