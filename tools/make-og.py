# -*- coding: utf-8 -*-
"""Снимок развёрнутой карты для превью ссылки: og-image.jpg, 1200×630 (ТЗ раздел 10, этап 10).

Запуск (из папки dragon-coast-map/):
    python tools/make-og.py                  # пишет og-image.jpg рядом с index.html
    python tools/make-og.py --out other.jpg --port 8793

Скрипт поднимает свой http.server, открывает интерактивную карту в окне 1920×1080 (раскладка wide, море стоит,
вступление считается просмотренным), прячет нижнюю полосу, подсказки и панель, снимает кадр и вырезает из него
участок с шапкой, листом и валиками в пропорции 1200×630. Старый файл не удаляется: он переносится в ../rejected/.
"""
import argparse
import functools
import http.server
import io
import os
import re
import shutil
import socketserver
import sys
import threading
import time

from PIL import Image
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_shell():
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
                        v = int(m.group(1))
                        if best is None or v > best[0]:
                            best = (v, os.path.join(root, f))
    return best[1] if best else None


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REPO, 'og-image.jpg'))
    ap.add_argument('--port', type=int, default=8793)
    ap.add_argument('--quality', type=int, default=86)
    args = ap.parse_args()
    srv = Srv(('127.0.0.1', args.port), functools.partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=ARGS, executable_path=find_shell())
        ctx = b.new_context(viewport={'width': 1920, 'height': 1080})
        ctx.add_init_script("try{sessionStorage.setItem('dcm:intro','1');localStorage.setItem('dcm:motion','off');localStorage.setItem('dcm:coach','1');}catch(e){}")
        page = ctx.new_page()
        page.goto(f'http://127.0.0.1:{args.port}/index.html', wait_until='load')
        page.wait_for_function("() => window.__map && __map.state() === 'ready'", timeout=60000)
        page.wait_for_timeout(2500)   # блики и появление подписей доигрывают
        page.add_style_tag(content='.band, #coach, #toast, #tip, #panel, .rail { display: none !important; }')
        page.wait_for_timeout(300)
        box = page.evaluate("""() => { const g = __map.geo(), h = document.querySelector('.app-head').getBoundingClientRect();
          return { top: h.top, bottom: g.paper.top + g.paper.h, cx: g.paper.left + g.paper.w / 2 }; }""")
        png = page.screenshot()
        b.close()
    srv.shutdown()
    img = Image.open(io.BytesIO(png)).convert('RGB')
    # вырезаем от шапки до низа листа с небольшими полями, в пропорции 1200:630
    top = max(0, int(box['top'] - 36)); bottom = min(img.height, int(box['bottom'] + 70))
    h = bottom - top; w = int(h * 1200 / 630)
    left = int(box['cx'] - w / 2)
    left = max(0, min(img.width - w, left))
    crop = img.crop((left, top, left + w, top + h)).resize((1200, 630), Image.LANCZOS)
    if os.path.exists(args.out):
        rej = os.path.join(os.path.dirname(REPO), 'rejected')
        os.makedirs(rej, exist_ok=True)
        stem, ext = os.path.splitext(os.path.basename(args.out))
        shutil.move(args.out, os.path.join(rej, f'{stem}.{time.strftime("%Y%m%d-%H%M%S")}{ext}'))
    crop.save(args.out, 'JPEG', quality=args.quality, optimize=True, progressive=True)
    print(f'{args.out}: {crop.size[0]}×{crop.size[1]}, {os.path.getsize(args.out)} байт; вырез {w}×{h} из {img.size}')


if __name__ == '__main__':
    main()
