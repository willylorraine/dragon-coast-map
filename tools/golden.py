# -*- coding: utf-8 -*-
"""Эталонные кадры карты «Драконье побережье» для проверки I2 (ТЗ 3.11, 3.12, раздел 9.I).

Снимает режимы ?video и ?alpha в точках t = 2, 4, 6, 9 (window.renderAt) в viewport 1280×720.
Эталон снимается с дерева коммита 007cc11, распакованного в map/tests/golden-src/, а не с рабочей
копии. Если задан --fallback, в том же прогоне после renderAt(9) берётся кадр шейдера без оверлея
(холст #gl через toDataURL), сжимается до ширины 3372 px и пишется в WebP качества 80: это
tex_fallback.webp для браузеров без WebGL.

Запуск (эталон):
    python tools/golden.py --src ../tests/golden-src --port 8794 --out ../tests/golden --fallback tex_fallback.webp

Скрипт сам поднимает http.server на 127.0.0.1 и гасит его в конце. Браузер: chrome-headless-shell
самой новой сборки из кэша Playwright (как в tests/qa_buttons.py); путь задаётся --chromium.
Старые файлы не удаляются: перед записью они переносятся в map/rejected/ с суффиксом времени.
"""

import argparse
import base64
import io
import os
import re
import subprocess
import sys
import time
import urllib.request

from PIL import Image
from playwright.sync_api import sync_playwright

TIMES = (2, 4, 6, 9)
VIEWPORT = {'width': 1280, 'height': 720}
LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
FALLBACK_WIDTH = 3372
ATTEMPTS = 4

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REJECTED = os.path.join(os.path.dirname(REPO), 'rejected')

LOST_JS = ("document.addEventListener('webglcontextlost', () => { window.__lost = (window.__lost || 0) + 1; },"
           " true);")
GL_LOST_JS = ("() => { const c = document.getElementById('gl'); const g = c && c.getContext('webgl');"
              " return !g || g.isContextLost(); }")
FRAMES_JS = "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"
FALLBACK_JS = ("() => { window.renderAt(9); return document.getElementById('gl').toDataURL('image/png'); }")


def find_headless_shell():
    """chrome-headless-shell самой новой сборки из кэша Playwright; None, если его нет."""
    base = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')
    best = None
    if os.path.isdir(base):
        for d in os.listdir(base):
            m = re.fullmatch(r'chromium_headless_shell-(\d+)', d)
            if not m:
                continue
            for root, _dirs, files in os.walk(os.path.join(base, d)):
                for f in files:
                    if f in ('chrome-headless-shell.exe', 'chrome-headless-shell'):
                        ver = int(m.group(1))
                        if best is None or ver > best[0]:
                            best = (ver, os.path.join(root, f))
    return best[1] if best else None


def start_server(port, directory):
    proc = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1',
                             '--directory', directory],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}/index.html'
    for _ in range(50):
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                r.read(16)
            return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError(f'http.server не поднялся на порту {port}')


def retire(path):
    """Старый файл не удаляем: переносим в map/rejected/ с суффиксом времени."""
    if not os.path.exists(path):
        return
    os.makedirs(REJECTED, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(path))
    stamp = time.strftime('%Y%m%d-%H%M%S')
    dst = os.path.join(REJECTED, f'{stem}.{stamp}{ext}')
    n = 1
    while os.path.exists(dst):
        dst = os.path.join(REJECTED, f'{stem}.{stamp}-{n}{ext}')
        n += 1
    os.replace(path, dst)
    print(f'  старый файл перенесён: {dst}', flush=True)


def open_ready(browser, url):
    """Открывает страницу в новом контексте, ждёт window.__ready и перезагружает, если WebGL потерян."""
    for attempt in range(1, ATTEMPTS + 1):
        ctx = browser.new_context(viewport=VIEWPORT)
        ctx.add_init_script(LOST_JS)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(url, wait_until='load', timeout=60000)
        page.wait_for_function('() => window.__ready === true', timeout=60000)
        page.wait_for_timeout(1000)
        lost = page.evaluate(GL_LOST_JS)
        if not lost or attempt == ATTEMPTS:
            return ctx, page, errors, lost
        print(f'  WebGL потерян (попытка {attempt}), перезагрузка', flush=True)
        ctx.close()
    raise RuntimeError('не удалось открыть страницу')


def save_fallback(data_url, path):
    png = base64.b64decode(data_url.split(',', 1)[1])
    img = Image.open(io.BytesIO(png)).convert('RGBA')
    w, h = img.size
    if w > FALLBACK_WIDTH:
        img = img.resize((FALLBACK_WIDTH, round(h * FALLBACK_WIDTH / w)), Image.LANCZOS)
    elif w < FALLBACK_WIDTH:
        print(f'  внимание: холст шириной {w} px меньше {FALLBACK_WIDTH}, масштаб не менял', flush=True)
    retire(path)
    img.save(path, 'WEBP', quality=80, method=6)
    print(f'  фолбэк: холст {w}×{h} -> {img.size[0]}×{img.size[1]}, {os.path.getsize(path)} байт: {path}',
          flush=True)


def capture(browser, base, query, out_dir, prefix, omit, fallback=None):
    ctx, page, errors, lost = open_ready(browser, f'{base}/index.html?{query}')
    if lost:
        print(f'  внимание: WebGL остался потерянным после {ATTEMPTS} попыток', flush=True)
    try:
        for t in TIMES:
            page.evaluate('t => window.renderAt(t)', t)
            page.evaluate(FRAMES_JS)
            path = os.path.join(out_dir, f'{prefix}_t{t}.png')
            retire(path)
            page.screenshot(path=path, omit_background=omit)
            print(f'  снят {os.path.basename(path)} ({os.path.getsize(path)} байт)', flush=True)
        if fallback:
            save_fallback(page.evaluate(FALLBACK_JS), fallback)
    finally:
        ctx.close()
    return errors


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(description='Эталонные кадры ?video и ?alpha (ТЗ 3.12, раздел 9.I).')
    ap.add_argument('--src', required=True, help='папка сайта (для эталона — дерево коммита 007cc11)')
    ap.add_argument('--port', type=int, required=True, help='порт http.server на 127.0.0.1')
    ap.add_argument('--out', required=True, help='папка для video_t*.png и alpha_t*.png')
    ap.add_argument('--fallback', help='путь WebP кадра без оверлея (снимается после renderAt(9) в ?video)')
    ap.add_argument('--chromium', help='путь к chrome-headless-shell (по умолчанию самый новый в кэше)')
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out)
    fallback = os.path.abspath(args.fallback) if args.fallback else None
    os.makedirs(out, exist_ok=True)
    base = f'http://127.0.0.1:{args.port}'
    exe = args.chromium or find_headless_shell()

    proc = start_server(args.port, src)
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=LAUNCH_ARGS, executable_path=exe or None)
            print(f'Браузер: {browser.version} ({exe or "по умолчанию Playwright"})', flush=True)
            try:
                print('?video', flush=True)
                errors += capture(browser, base, 'video', out, 'video', omit=False, fallback=fallback)
                print('?video&alpha', flush=True)
                errors += capture(browser, base, 'video&alpha', out, 'alpha', omit=True)
            finally:
                browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    if errors:
        print('Ошибки страницы:', flush=True)
        for e in errors:
            print(f'  {e}', flush=True)
        sys.exit(1)
    print('готово', flush=True)


if __name__ == '__main__':
    main()
