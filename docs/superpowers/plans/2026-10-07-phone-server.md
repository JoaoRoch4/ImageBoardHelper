# Phone Server, Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local HTTP+JSON server running natively in Termux that controls the phone (links and apps, notifications and clipboard, screen and input, commands and files) for every consumer on the device.

**Architecture:** `tools/phone-server.mts` (server + CLI) on Node's `http`, routes in a table, one persistent rish session from a new shared `tools/rish.mts` (moved out of the phone MCP), Termux:API commands for notifications/clipboard/toast. Everything external is reached through env-overridable paths, so the tests run in the container against stub commands.

**Tech Stack:** Node 26 natively / 24 in the container, TypeScript run by type stripping (`.mts`), `node:test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-phone-server-design.md`

## Global Constraints

- No dependencies. `.mts` ES modules run by Node as they are: erasable syntax only, `import type` for types, relative imports with the `.mts` extension. `tsc -p tools` passes under TypeScript 7 (`npx tsc -p tools`) and 5.9 (`node /usr/local/lib/node_modules/typescript/bin/tsc -p tools`).
- Code, comments and docs in English; comments explain lines that are not self-explanatory (repo convention).
- Listens on `127.0.0.1:8730` only.
- Token: 32 random bytes in hex, `~/.config/ibh-server/token`, mode 600, created on the first `serve`, compared in constant time; header `Authorization: Bearer <token>`.
- Log: one line per request (time, route, ms, ok or the error) in `~/.config/ibh-server/server.log`, cut back past 1 MB; request bodies never logged.
- Errors: `{ ok: false, error }` with 400 bad input, 401 token, 404 route, 503 Shizuku or Termux:API missing, 500 otherwise. Success: `{ ok: true, ... }`.
- Limits: `run` timeout ≤ 600 s, its stdout and stderr cut at 1 MB each; `file` ≤ 20 MB; `record` 1–15 s.
- Env overrides (for tests, defaults in brackets): `IBH_SERVER_DIR` [`~/.config/ibh-server`], `IBH_SERVER_PORT` [`8730`], `RISH` [found by `findRish()`], `IBH_TERMUX_BIN` [empty: `termux-*` from PATH], `HOME` for `install-boot`.

## Review Focus

- Two requests at once on rish routes: both must succeed, in order (one session, queued). Test in Task 4.
- Shizuku dying mid-session: the next request starts a new rish session instead of failing forever. Test in Task 1.
- A body that is not JSON, or bigger than the 20 MB file limit plus base64 overhead (30 MB): 400 or 413, the server keeps running. Test in Task 2.
- `call` with no token file (server never started here): a clear message naming the file, exit 1. Test in Task 2.
- A second `serve` while one runs: "port 8730 busy (a server already running?)", exit 1. Test in Task 2.

---

### Task 1: `tools/rish.mts`, the shared rish session

**Files:**
- Create: `tools/rish.mts`, `tools/rish.test.mts`
- Modify: `tools/phone-mcp.mts` (lines 37–38 and 99–174: drop `LOCAL_RISH`/`RISH`, `RishCommand`, `RishSession`, `session`, `rishSession`, `pump`, `rish`, `shizukuUp`; import them), `package.json` (scripts)

**Interfaces:**
- Produces: `findRish(): string`; `rish(cmd: string, timeout?: number): Promise<{ out: string; code: number }>` (default 20000 ms; rejects with `Error` when the session cannot start or dies); `shizukuUp(): Promise<boolean>`; `stopRish(): void` (kills the session; for tests and shutdown).
- `findRish()` order: `$RISH`, `~/.local/bin/rish` if it exists, `/data/data/com.termux/files/usr/var/lib/proot-distro/containers/fedora/rootfs/root/.local/bin/rish` if it exists, else `'rish'`.

- [ ] **Step 1: Write the failing tests** in `tools/rish.test.mts` (`node:test`, `node:assert/strict`). Before importing, set `process.env.RISH` to a fake rish written to a temp dir: a `#!/bin/sh` script `exec sh` (the session protocol is plain shell on stdin, so a shell is a faithful stand-in). Tests:

```ts
test('runs a command', async () => assert.deepEqual(await rish('echo hi'), { out: 'hi', code: 0 }))
test('carries the exit code', async () => assert.equal((await rish('false')).code, 1))
test('merges stderr in order', async () => assert.equal((await rish('echo a; echo b >&2; echo c')).out, 'a\nb\nc'))
test('queues concurrent commands', async () => assert.deepEqual((await Promise.all([rish('sleep 0.2; echo 1'), rish('echo 2')])).map(r => r.out), ['1', '2']))
test('a stuck command times out and the next one gets a new session', async () => {
  await assert.rejects(rish('sleep 5', 300))
  assert.equal((await rish('echo back')).out, 'back')
})
test('a session that dies is replaced', async () => {   // the fake rish exits: Shizuku went down
  await rish('kill -9 $$').catch(() => {})
  assert.equal((await rish('echo again')).out, 'again')
})
```
  End with `after(stopRish)`.

- [ ] **Step 2: Run, expect failure** — `node --test tools/rish.test.mts` → FAIL, cannot find module `./rish.mts`.

- [ ] **Step 3: Create `tools/rish.mts`** by moving the session code from `phone-mcp.mts` unchanged in behaviour (marker protocol, `stdio: 'pipe'`, both channels into one buffer, `</dev/null` per command, timeout kills the session), plus `findRish()` and `stopRish()`. Header comment as in the moved code.

- [ ] **Step 4: Run, expect pass** — `node --test tools/rish.test.mts` → 6 pass.

- [ ] **Step 5: Point the MCP at it** — in `phone-mcp.mts`, `import { rish, shizukuUp } from './rish.mts'`; `phoneShell` and `wirelessDebugging` keep calling `rish`. Add `"test:tools": "node --test tools/rish.test.mts"` to `package.json` and append `&& npm run -s test:tools` to `check`.

- [ ] **Step 6: Verify** — `npx tsc -p tools` and the TS 5.9 command: no output. MCP over stdio (the harness that drives `node tools/phone-mcp.mts` with JSON-RPC): `tools/list` → 28 tools; `status` → its first line says `Shizuku (rish): running`.

- [ ] **Step 7: Commit** — `git add tools/rish.mts tools/rish.test.mts tools/phone-mcp.mts package.json && git commit -m "tools/rish.mts: the rish session, shared"`

### Task 2: the server core, `status`, and the CLI

**Files:**
- Create: `tools/phone-server.mts`, `tools/phone-server.test.mts`
- Modify: `package.json` (`test:tools` runs both test files)

**Interfaces:**
- Consumes: `shizukuUp()` from Task 1.
- Produces, in `phone-server.mts`:
  - `class HttpError extends Error { status: number }` — thrown by handlers, turned into the error answer.
  - `type Handler = (body: Record<string, unknown>) => Promise<Record<string, unknown>>`; `const ROUTES: Record<string, Handler>` (keys are route names; `status` is the only GET).
  - `termux(name: string, args: string[], input?: string): Promise<string>` — runs `${IBH_TERMUX_BIN}${name}`; a missing command (`ENOENT`) throws `HttpError(503, 'Termux:API is not installed …')`.
  - `serverDir()`, `readToken(create: boolean): string`.
  - CLI: `serve`, `token`, `call <route> [json]` (prints the JSON answer, exit 0 when `ok`, else 1).

- [ ] **Step 1: Write the failing tests** in `tools/phone-server.test.mts`. A `before` hook makes a temp dir, picks a free port (listen on 0, read it, close), spawns `node tools/phone-server.mts serve` with `IBH_SERVER_DIR`, `IBH_SERVER_PORT`, `RISH` (the fake from Task 1, extended in Task 4) and `IBH_TERMUX_BIN` (a stub dir, filled in Tasks 3 and 5), and waits for the port. Helpers: `req(route, body?, token = TOKEN)` returns `{ status, json }`; `calls()` returns the lines of `<dir>/calls.log` (the stubs' record, Tasks 4–5) and `lastCall()` its last line; `pick(obj, ...keys)` keeps those keys. Tests:

```ts
test('the token file is created with mode 600', () => assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600))
test('no token: 401', async () => assert.equal((await req('status', undefined, '')).status, 401))
test('wrong token: 401', async () => assert.equal((await req('status', undefined, 'x'.repeat(64))).status, 401))
test('unknown route: 404', async () => assert.equal((await req('nope', {})).status, 404))
test('a body that is not JSON: 400, and the server lives on', async () => { /* raw POST 'not json' → 400; then status → 200 */ })
test('a body over 30 MB: 413', async () => { /* POST 31 MB → 413 */ })
test('status', async () => { const { json } = await req('status'); assert.equal(json.ok, true); assert.equal(typeof json.version, 'string'); assert.equal(typeof json.shizuku, 'boolean') })
test('the log has one line per request and no body', () => { /* server.log contains 'status' and never the 'not json' text */ })
test('a second serve on the same port says so', async () => { /* spawn serve again → exit 1, stderr matches /port \d+ busy/ */ })
test('call without a token file names the file', async () => { /* call status with IBH_SERVER_DIR=empty dir → exit 1, stderr includes 'token' and the path */ })
```

- [ ] **Step 2: Run, expect failure** — `node --test tools/phone-server.test.mts` → FAIL (no such file).

- [ ] **Step 3: Implement the core** in `phone-server.mts`: `http.createServer` on `127.0.0.1`, auth with `crypto.timingSafeEqual` (lengths compared first), body read capped at 30 MB (413), JSON parse (400), dispatch through `ROUTES`, the log line after each request (append; when the file passes 1 MB keep its last 512 KB), `EADDRINUSE` → the busy message; no CORS headers on any answer (a web page can neither read answers nor act without the token). `status` answers `{ version: '1.0.0', uptime_s, shizuku: await shizukuUp(), termuxApi }` (`termuxApi`: whether `termux-toast` exists in `IBH_TERMUX_BIN` or PATH). `call` reads the token without creating it and POSTs (GET for `status`).

- [ ] **Step 4: Run, expect pass** — `node --test tools/phone-server.test.mts` → 10 pass; `npm run -s test:tools` → both files pass.

- [ ] **Step 5: Commit** — `git commit -m "phone server: core, auth, status, CLI"` (with the two files and `package.json`).

### Task 3: Termux-side routes — `run`, `file`, `device`

**Files:** Modify `tools/phone-server.mts`, `tools/phone-server.test.mts` (and the stub dir setup: a `termux-battery-status` that prints `{"percentage":80,"status":"DISCHARGING","temperature":30.5}`).

**Interfaces:** Consumes `ROUTES`, `HttpError`, `termux()` from Task 2. Adds `ROUTES.run`, `ROUTES.file`, `ROUTES.device`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('run', async () => assert.deepEqual(pick((await req('run', { command: 'echo hi; echo err >&2; exit 3' })).json, 'code', 'stdout', 'stderr'), { code: 3, stdout: 'hi\n', stderr: 'err\n' }))
test('run in a folder', async () => assert.equal((await req('run', { command: 'pwd', cwd: dir })).json.stdout.trim(), dir))
test('run times out', async () => { const { json } = await req('run', { command: 'sleep 5', timeout: 1 }); assert.equal(json.timedOut, true) })
test('run cuts output at 1 MB', async () => { const { json } = await req('run', { command: 'head -c 2000000 /dev/zero | tr "\\0" a' }); assert.equal(json.stdout.length, 1048576); assert.equal(json.cut, true) })
test('run refuses a timeout over 600 s', async () => assert.equal((await req('run', { command: 'true', timeout: 601 })).status, 400))
test('file: write then read, utf8 and base64', async () => { /* write 'olá' utf8 → read utf8 'olá'; write base64 of [0,1,2] → read base64 same */ })
test('file: reading a missing file is 400 naming it', async () => { /* status 400, error includes the path */ })
test('file: over 20 MB is refused', async () => { /* write 21 MB utf8 → 400 */ })
test('device', async () => { const { json } = await req('device', {}); assert.equal(json.battery.percentage, 80); assert.ok(json.memory.total_mb > 0); assert.ok('storage' in json && 'network' in json) })
```

- [ ] **Step 2: Run, expect failure** — the new tests FAIL with 404.

- [ ] **Step 3: Implement** — `run`: `spawn('bash', ['-lc', command], { cwd })`, kill on timeout (default 60 s), answer `{ code, stdout, stderr, timedOut, cut }`. `file`: `encoding` defaults to `utf8`; write creates parent folders. `device`: `termux-battery-status` JSON (null when Termux:API is missing, not an error), `/proc/meminfo` totals, `df -k /sdcard ~` parsed, `ip -o addr` addresses.

- [ ] **Step 4: Run, expect pass** — `node --test tools/phone-server.test.mts` → all pass.

- [ ] **Step 5: Commit** — `git commit -m "phone server: run, file, device"`.

### Task 4: rish routes — `open`, `apps`, `screenshot`, `record`, `input`

**Files:** Modify `tools/phone-server.mts`, `tools/phone-server.test.mts`. The fake rish becomes `PATH=<stubs>:$PATH exec sh`; stubs `am`, `monkey`, `pm`, `cmd`, `input`, `screencap`, `screenrecord` append `"$0 $*"` (basename) as one line to `<dir>/calls.log`; `screencap` also writes a 1×1 PNG to its last argument, `pm` prints `package:org.videolan.vlc`.

**Interfaces:** Consumes `rish()` (Task 1), `ROUTES`/`HttpError` (Task 2). Adds `ROUTES.open|apps|screenshot|record|input`. Shizuku down (`rish` rejects) → `HttpError(503, 'Shizuku is not answering: start it in the Shizuku app')`.

- [ ] **Step 1: Write the failing tests** (each reads the last line of `calls.log`):

```ts
test('open a link in an app', async () => { await req('open', { url: 'https://rule34.xxx/', app: 'org.mozilla.fenix' }); assert.equal(lastCall(), "am start -a android.intent.action.VIEW -d https://rule34.xxx/ org.mozilla.fenix") })
test('open an app alone', async () => { await req('open', { app: 'org.videolan.vlc' }); assert.equal(lastCall(), 'monkey -p org.videolan.vlc -c android.intent.category.LAUNCHER 1') })
test('open refuses quotes and spaces', async () => assert.equal((await req('open', { url: "https://x/'; rm -rf ~" })).status, 400))
test('apps by name', async () => assert.deepEqual((await req('apps', { filter: 'vlc' })).json.packages, ['org.videolan.vlc']))
test('input tap, and out-of-range coordinates refused', async () => { await req('input', { action: 'tap', x: 10, y: 20 }); assert.equal(lastCall(), 'input tap 10 20'); assert.equal((await req('input', { action: 'tap', x: -1, y: 20 })).status, 400) })
test('screenshot inline', async () => { const { json } = await req('screenshot', { inline: true }); assert.ok(json.path.endsWith('.png')); assert.ok(Buffer.from(json.base64, 'base64').subarray(1, 4).toString() === 'PNG') })
test('record clamps to 1-15 s', async () => { await req('record', { seconds: 99 }); assert.match(lastCall(), /^screenrecord --time-limit 15 /) })
test('two rish requests at once both succeed', async () => { const [a, b] = await Promise.all([req('input', { action: 'key', key: 'BACK' }), req('input', { action: 'key', key: 'HOME' })]); assert.equal(a.json.ok && b.json.ok, true) })
test('Shizuku down: 503', async () => { /* a second server with RISH=/nonexistent → open → 503 */ })
```

- [ ] **Step 2: Run, expect failure** — new tests FAIL with 404.

- [ ] **Step 3: Implement** — validation as the MCP's: URL `^[a-z]+://[^\s'"\\]+$` (http, https, intent…), package `^[\w.]+$`, input coordinates 0–10000 and keys `^(KEYCODE_)?[A-Z0-9_]+$`, `text` single-quoted with spaces as `%s`. Files go to `/sdcard/Download/ibh-server-<time>.png|.mp4`; `record` waits `seconds + 20` s on the rish call.

- [ ] **Step 4: Run, expect pass** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "phone server: open, apps, screenshot, record, input"`.

### Task 5: Termux:API routes — `notify`, `clipboard`, `toast`

**Files:** Modify `tools/phone-server.mts`, `tools/phone-server.test.mts` (stubs `termux-notification`, `termux-toast`, `termux-clipboard-set` append their args to `calls.log`; `termux-clipboard-get` prints `copied text`).

**Interfaces:** Consumes `termux()` (Task 2), `findRish()` (Task 1). Adds `ROUTES.notify|clipboard|toast`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('notify with a link', async () => { await req('notify', { title: 'Deploy', text: 'v1.9 ok', url: 'https://rule34.xxx/', id: 'deploy' }); const call = lastCall(); assert.match(call, /^termux-notification --title Deploy --content v1.9 ok --id deploy --action /); assert.match(call, /am start -a android.intent.action.VIEW -d 'https:\/\/rule34.xxx\/'/) })
test('clipboard read', async () => assert.equal((await req('clipboard', {})).json.text, 'copied text'))
test('clipboard write goes through stdin', async () => { await req('clipboard', { set: "it's" }); assert.deepEqual(calls().slice(-2), ['termux-clipboard-set', "it's"]) })   // the stub logs its args, then its stdin
test('toast', async () => { await req('toast', { text: 'oi' }); assert.equal(lastCall(), 'termux-toast oi') })
test('Termux:API missing: 503', async () => { /* a server with IBH_TERMUX_BIN=/nonexistent/ → toast → 503 */ })
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement** — `notify`'s action is a shell line run by Termux on the tap: `<findRish() natively> -c "am start -a android.intent.action.VIEW -d '<url>'"`, the URL validated as in `open`. `clipboard set` passes the text on stdin (no quoting through argv).

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "phone server: notify, clipboard, toast"`.

### Task 6: boot, docs, and the live check on the phone

**Files:** Modify `tools/phone-server.mts` (`install-boot`), `tools/phone-server.test.mts`, `CLAUDE.md` (a paragraph under "Testar", next to the phone MCP), `.claude/skills/phone-workflow/SKILL.md` (a short "Phone server" section).

**Interfaces:** Adds the CLI command `install-boot`.

- [ ] **Step 1: Write the failing test** — `install-boot` with `HOME=<temp>` writes `<temp>/.termux/boot/ibh-server.sh`, mode 0o755, containing `termux-wake-lock`, `tmux has-session -t ibh || tmux new-session -d -s ibh`, and `node /data/data/com.termux/files/usr/var/lib/proot-distro/containers/fedora/rootfs/root/ImageBoardHelper/tools/phone-server.mts serve`.

- [ ] **Step 2: Run, expect failure;** **Step 3: implement;** **Step 4: run, expect pass** (`npm run -s check` all green, both TypeScripts clean).

- [ ] **Step 5: Live check** — start natively through the MCP's `termux_run` (`node <rootfs path>/tools/phone-server.mts serve`, window `server`); from the container: `node tools/phone-server.mts call status` (`shizuku: true`, `termuxApi: true`), `call apps '{"filter":"mozilla"}'` (lists `org.mozilla.fenix`), `call device`, `call file '{"path":"/data/data/com.termux/files/home/.bashrc"}'`, `call run '{"command":"uname -m"}'` (`aarch64`), `call clipboard`, a request without the token (401). Ask the user before `open`, `notify`, `toast` or `input`; with their yes, `call notify` with a link and confirm the tap opens it. Then run `install-boot` natively.

- [ ] **Step 6: Docs** — CLAUDE.md: what the server is, `serve`/`call`/`token`/`install-boot`, the token path, 127.0.0.1:8730, and that the MCP does not use it yet. Skill: when to use `call` instead of `termux_run`.

- [ ] **Step 7: Commit** — `git commit -m "phone server: Termux:Boot script, docs"`.
