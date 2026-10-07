#!/usr/bin/env python3
# Development helper, not part of the userscript.
#
# Opens a booru page (rule34 by default) in Playwright's headless Firefox
# with the userscript injected, the GM functions stubbed in memory as in
# tools/smoke.js, and reports what came back: a Cloudflare challenge, or
# the script's version, thumbnails and last log lines, plus a screenshot.
#
#   python3 tools/test.py [URL] [--wait S] [--log N] [--eval EXPR] [--shot FILE] [--solve]
#
# The browser poses as the phone's Firefox (user agent, 360 px screen at
# DPR 2, touch) and keeps a profile in ~/.cache/ibh-test/profile. When
# Cloudflare answers with a challenge, the same browser is started visible
# on a virtual screen (Xvfb), shown in the phone's Firefox through noVNC
# (on 127.0.0.1 only, with a one-time password) for the user to solve; the
# pass Cloudflare then sets stays in the profile for the next runs.
# --solve opens that view even without a challenge.
# One-time setup: pip install playwright==1.63.0 (the version of the Node
# tools, so it runs the Firefox that `npx playwright install firefox` got);
# dnf install xorg-x11-server-Xvfb x11vnc novnc python3-websockify.

import argparse
import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = (REPO / 'image-board-helper.user.js').read_text(encoding='utf-8')
PHONE_UA = 'Mozilla/5.0 (Android 16; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0'
WORK = pathlib.Path.home() / '.cache' / 'ibh-test'
PROFILE = WORK / 'profile'   # cookies kept between runs: a solved challenge carries over
RISH = str(pathlib.Path.home() / '.local' / 'bin' / 'rish')
DISPLAY = ':99'
VNC_PORT, WEB_PORT = 5999, 6080

# What Violentmonkey would provide, in memory, and the feed on as the phone
# has it. @noframes by hand: init scripts run in every frame.
INJECT = """if (window.top === window) {
  const store = new Map()
  window.GM_getValue = (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d)
  window.GM_setValue = (k, v) => { store.set(k, JSON.stringify(v)) }
  window.GM_xmlhttpRequest = d => setTimeout(() => d.onerror && d.onerror(new Error('stub')), 0)
  window.unsafeWindow = window
  try { if (!localStorage.getItem('IBH_CFG')) localStorage.setItem('IBH_CFG', JSON.stringify({ nativeFeed: true })) } catch (e) {}
  %s
}""" % SCRIPT

# A Cloudflare challenge page instead of the site: its title, or its pieces.
CHALLENGE = """() => /just a moment|um momento|attention required/i.test(document.title) ||
  !!document.querySelector('#challenge-running, #challenge-form, .cf-turnstile, script[src*="challenge-platform"]')"""


def phone_firefox():
    """The Firefox the phone MCP last connected to (Beta or Nightly)."""
    try:
        return (pathlib.Path.home() / '.cache' / 'ibh-mcp' / 'firefox-app').read_text().strip() or 'org.mozilla.fenix'
    except OSError:
        return 'org.mozilla.fenix'


def wait_for(check, what, seconds=20):
    """Polls until check() is true: services start slowly under proot (websockify ~3 s)."""
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return
        time.sleep(0.3)
    raise RuntimeError(f'{what} did not start in {seconds} s')


def port_open(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


def start_view():
    """A virtual screen, a VNC server on it and noVNC in front, all on
    127.0.0.1. Returns (processes, the noVNC address with its password)."""
    password = secrets.token_hex(4)   # one-time: x11vnc reads at most 8 characters
    pw_file = WORK / 'vnc.pass'
    subprocess.run(['x11vnc', '-storepasswd', password, str(pw_file)], check=True, capture_output=True)
    def bg(cmd):   # a background process, quiet
        return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs = [bg(['Xvfb', DISPLAY, '-screen', '0', '420x880x24', '-nolisten', 'tcp'])]
    wait_for(lambda: pathlib.Path(f'/tmp/.X11-unix/X{DISPLAY[1:]}').exists(), 'Xvfb')
    procs.append(bg(['x11vnc', '-display', DISPLAY, '-localhost', '-rfbport', str(VNC_PORT),
                     '-rfbauth', str(pw_file), '-forever', '-shared', '-quiet']))
    wait_for(lambda: port_open(VNC_PORT), 'x11vnc')
    procs.append(bg(['websockify', '--web', '/usr/share/novnc', f'127.0.0.1:{WEB_PORT}', f'127.0.0.1:{VNC_PORT}']))
    wait_for(lambda: port_open(WEB_PORT), 'websockify')
    return procs, f'http://127.0.0.1:{WEB_PORT}/vnc.html?autoconnect=1&resize=scale&password={password}'


def open_on_phone(url):
    app = phone_firefox()
    subprocess.run([RISH, '-c', f"am start -a android.intent.action.VIEW -d '{url}' {app}"],
                   capture_output=True, timeout=60, check=False)
    return app


def open_browser(p, visible):
    PROFILE.mkdir(parents=True, exist_ok=True)
    context = p.firefox.launch_persistent_context(
        str(PROFILE), headless=not visible, env={**os.environ, 'DISPLAY': DISPLAY} if visible else None,
        viewport={'width': 360, 'height': 780}, device_scale_factor=2, has_touch=True,
        user_agent=PHONE_UA, locale='pt-BR')
    context.add_init_script(INJECT)
    return context


def main():
    ap = argparse.ArgumentParser(description='Open a booru page with the userscript injected.')
    ap.add_argument('url', nargs='?', default='https://rule34.xxx/index.php?page=post&s=list&tags=all')
    ap.add_argument('--wait', type=float, default=8, help='seconds to let the page and the script settle (default 8)')
    ap.add_argument('--log', type=int, default=15, help='last log lines to print (default 15)')
    ap.add_argument('--eval', dest='expr', help='a JS expression to evaluate in the page and print')
    ap.add_argument('--shot', default=str(WORK / 'shot.png'), help='screenshot path (default ~/.cache/ibh-test/shot.png)')
    ap.add_argument('--solve', action='store_true', help='open the visible browser on the phone even without a challenge')
    ap.add_argument('--solve-wait', type=int, default=300, help='seconds to wait for the challenge to be solved (default 300)')
    args = ap.parse_args()

    with sync_playwright() as p:
        context, view = open_browser(p, visible=False), []
        page = context.pages[0] if context.pages else context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        try:
            res = page.goto(args.url, wait_until='domcontentloaded', timeout=60000)
            page.wait_for_timeout(args.wait * 1000)

            if args.solve or page.evaluate(CHALLENGE):
                # The same browser, visible on the virtual screen, shown on the phone.
                print('Cloudflare challenge: opening the browser on the phone to be solved' if not args.solve
                      else 'opening the browser on the phone (--solve)')
                context.close()
                view, address = start_view()
                context = open_browser(p, visible=True)
                page = context.pages[0] if context.pages else context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                res = page.goto(args.url, wait_until='domcontentloaded', timeout=60000)
                print(f'shown in {open_on_phone(address)}: {address.split("?")[0]}; waiting up to {args.solve_wait} s')
                end = time.time() + args.solve_wait
                while time.time() < end and page.evaluate(CHALLENGE):
                    page.wait_for_timeout(2000)
                if page.evaluate(CHALLENGE):
                    print('still a challenge: gave up waiting')
                    return 2
                print('past the challenge (the pass stays in the profile)' if not args.solve else 'done')
                page.wait_for_timeout(args.wait * 1000)

            pathlib.Path(args.shot).parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=args.shot)
            print(f'{res.status if res else "?"} {page.url}\ntitle: {page.title()}\nscreenshot: {args.shot}')
            version = page.evaluate('() => window.__ibh && window.__ibh.version')
            if not version:
                print('the script did not start (no window.__ibh)')
                return 1
            thumbs = page.evaluate("() => document.querySelectorAll('.image-list span.thumb').length")
            print(f'script v{version}, {thumbs} thumbnails')
            print(page.evaluate('n => window.__ibh.tail(n)', args.log))
            if args.expr:
                print('eval:', json.dumps(page.evaluate(f'() => ({args.expr})'), ensure_ascii=False, indent=2))
            if errors:
                print('page errors:', *errors[:5], sep='\n  ')
            return 0
        finally:
            context.close()
            for proc in reversed(view):
                proc.terminate()


if __name__ == '__main__':
    sys.exit(main())
