# Phone server, part 1: the core and phone control

Date: 2026-10-07. Status: approved design, before the implementation plan.

## Why

The phone is driven today from the Fedora container (proot) through the
`phone` MCP: a rish session for shell commands as uid shell, adb for the
Firefox debugger, and tmux windows for native Termux jobs. Each consumer
re-implements its own way in. A small server running natively in Termux
gives every consumer on the device one local API: the container, the MCP,
other apps, and later the userscript (part 2), the Wi-Fi (part 3) and a
Termux:X11 view (part 4). Natively, a process skips proot's tracing (each
process ~3.6× slower in proot) and lives under Termux's foreground
service, which Android does not freeze.

This part covers only the core and phone control, on 127.0.0.1.

## Facts it builds on (checked on the device)

- Native Termux: uid 10307, Node 26.4 (runs `.mts` directly, stripping
  types), Python, Termux:API installed (`termux-notification`,
  `termux-clipboard-get/set`, `termux-toast`, `termux-battery-status`),
  Termux:Boot installed (no `~/.termux/boot` yet).
- The container's root filesystem is
  `/data/data/com.termux/files/usr/var/lib/proot-distro/containers/fedora/rootfs`:
  native Termux runs the repo's files from there, no copy.
- rish is a POSIX wrapper (`/root/.local/bin/rish` in the container) that
  runs `app_process` on `~/rish_shizuku.dex` in Termux's home: it works the
  same natively. Termux's home is visible from the container at the same
  path.
- As an app, Termux is refused `am`, and `termux-am` has no socket server in
  Termux 0.119.0-beta.3: opening apps and links goes through rish (uid
  shell).

## Design

### Files

- `tools/phone-server.mts`: the server and its command-line client.
  `serve` runs the server; `call <route> [json]` sends one request and
  prints the answer; `token` prints the token (creating it if missing);
  `install-boot` writes the Termux:Boot script below.
- `tools/rish.mts`: the persistent rish session, moved out of
  `tools/phone-mcp.mts` (one Java VM per session, commands through stdin
  with a marker carrying the exit code, both channels in one buffer). The
  MCP and the server import it. It finds rish at `$RISH`, then
  `~/.local/bin/rish` in the container, then the same file through the
  rootfs path natively.
- `~/.termux/boot/ibh-server.sh` (in Termux's home, written by
  `phone-server.mts install-boot`): takes Termux's wake lock and starts the
  server in a window of the tmux session `ibh`, creating the session if
  missing.

No dependencies; type-checked by `tsc -p tools` like the other `.mts` tools.

### Address and access

- Listens on `127.0.0.1:8730` only.
- Every request carries `Authorization: Bearer <token>`. The token is 32
  random bytes in hex, created on the first `serve` in
  `~/.config/ibh-server/token` (Termux's home, mode 600), compared in
  constant time. Any app on the phone can reach 127.0.0.1; the token is
  what keeps the others out.
- No CORS headers: a web page cannot read answers, and without the token it
  cannot act.

### API

JSON in, JSON out. `GET /status`; every action is `POST /<action>` with a
JSON body. Answers are `{ "ok": true, ... }`, or `{ "ok": false, "error":
"..." }` with 400 (bad input), 401 (token), 404 (route), 503 (Shizuku or
Termux:API missing) or 500.

| Route | Body | Does | Through |
|---|---|---|---|
| `GET /status` | | version, uptime, whether rish and Termux:API answer | |
| `open` | `url`, `app?` | opens a link (in `app`, e.g. `org.mozilla.fenix`), or launches `app` alone | rish: `am start` / `monkey -p` |
| `apps` | `url?`, `mime?`, `filter?` | apps that open a link, or installed packages matching a name | rish: `cmd package query-activities`, `pm list packages` |
| `notify` | `title`, `text`, `url?`, `id?` | a notification; with `url`, tapping it opens the link | Termux:API; the tap runs rish `am start` |
| `clipboard` | `set?` | reads the clipboard, or writes `set` | Termux:API |
| `toast` | `text` | a short toast | Termux:API |
| `screenshot` | `inline?` | the screen as PNG: its path, and base64 with `inline` | rish: `screencap` |
| `record` | `seconds` (1–15) | a screen recording: its path | rish: `screenrecord` |
| `input` | `action`, `x`, `y`, `x2`, `y2`, `ms`, `key`, `text` | tap, long press, swipe, key, text (validated as the MCP's `input`) | rish: `input` |
| `run` | `command`, `cwd?`, `timeout?` (s, ≤ 600) | a native command in a login bash: `code`, `stdout`, `stderr` (each cut at 1 MB) | Termux |
| `file` | `path`, `write?`, `encoding?` (`utf8`/`base64`) | reads a file, or writes `write` to it (≤ 20 MB) | Termux |
| `device` | | battery, memory, storage, network addresses | Termux:API, `/proc`, `df`, `ip` |

### Behaviour

- One rish session for the whole server, as in the MCP; when Shizuku is
  down, the routes that need it answer 503 with what to ask the user.
- One log line per request (time, route, ms, ok or the error) in
  `~/.config/ibh-server/server.log`, cut back when it passes 1 MB. The
  request bodies are not logged (clipboard text, file contents).
- The routes that go through rish queue on its one session; `run`,
  `file` and the Termux:API routes run alongside them.

### Testing

- `tsc -p tools` (TypeScript 7 and 5) and the MCP still working after the
  move of the rish session (`status`, `tabs` over its stdio).
- From the container, with `call`: `status`, `apps filter=…`, `clipboard`
  (read), `device`, `file` (read a known file), `run echo`, a 401 without
  the token and a 404.
- Routes that change what the user sees (`open`, `notify`, `toast`,
  `input`) only with the user told first.

### Out of this part

The userscript's routes (part 2), listening on the Wi-Fi (part 3), the
Termux:X11 view (part 4), and switching the MCP's tools over to the server.
