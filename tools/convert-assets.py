# -*- coding: utf-8 -*-
"""Пересоздаёт WebP рядом с оригиналами карты «Драконье побережье» (ТЗ 3.11).

Запуск из любой папки:
    python tools/convert-assets.py           конвертация, проверка, spriteSize, сводка
    python tools/convert-assets.py --check   только проверка уже созданных WebP, без записи

Оригиналы (PNG, JPG) не меняются и не удаляются. Параметры по таблице ТЗ 3.11:
    sprites/*.png              качество 82, альфа 90, method 6 (все спрайты, включая новые)
    tex_parchment.jpg          с потерями, 80
    tex_relief.png             с потерями, 90
    tex_ink.png, tex_mask.png  без потерь, method 6; exact=True сохраняет RGB под нулевой альфой
                               (оба файла RGB, на размер не влияет; в tex_mask цвета несут поле расстояний)
    brand/strazhi_gold.png     как спрайты: 82 / альфа 90 / method 6 (в таблице указан только .webp)

WebP, который новее своего оригинала, не пересоздаётся. Устаревший WebP переносится в map/rejected/
с суффиксом времени, новый пишется на его место.

После конвертации скрипт снимает натуральные размеры всех sprites/*.png и обновляет ключ
spriteSize в data/places.json (если файл есть; файл перезаписывается только при изменении,
старый переносится в rejected). Печатает таблицу до/после, проверку качества и сумму первой
загрузки. Без потерь проверяется побитовое совпадение декодированного WebP с оригиналом;
с потерями — PSNR по каналам.
"""

import glob
import json
import math
import os
import sys
import time

from PIL import Image, ImageChops, ImageStat, features

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_DIR = os.path.dirname(REPO)
REJECTED = os.path.join(MAP_DIR, 'rejected')
PLACES = os.path.join(REPO, 'data', 'places.json')
MB = 1_000_000  # ТЗ пишет мегабайты в десятичных единицах (1,79 МБ = 1 792 474 байта)

SPRITE_OPTS = {'quality': 82, 'alpha_quality': 90, 'method': 6}


def rel(path):
    return os.path.relpath(path, REPO).replace(os.sep, '/')


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
    print(f'  старый файл перенесён в rejected: {os.path.basename(dst)}')


def jobs():
    """(исходник, параметры WebP, описание режима) в порядке таблицы ТЗ 3.11."""
    out = [(p, dict(SPRITE_OPTS), 'спрайт: 82 / альфа 90 / method 6')
           for p in sorted(glob.glob(os.path.join(REPO, 'sprites', '*.png')))]
    out += [
        (os.path.join(REPO, 'tex_parchment.jpg'), {'quality': 80, 'method': 6}, 'с потерями, 80'),
        (os.path.join(REPO, 'tex_relief.png'), {'quality': 90, 'method': 6}, 'с потерями, 90'),
        (os.path.join(REPO, 'tex_ink.png'), {'lossless': True, 'exact': True, 'method': 6}, 'без потерь'),
        (os.path.join(REPO, 'tex_mask.png'), {'lossless': True, 'exact': True, 'method': 6}, 'без потерь'),
        (os.path.join(REPO, 'brand', 'strazhi_gold.png'), dict(SPRITE_OPTS), 'как спрайт: 82 / альфа 90'),
    ]
    return out


def mse_to_psnr(mse):
    return float('inf') if mse == 0 else 10 * math.log10(255 * 255 / mse)


def band_mse(a, b):
    """Средний квадрат ошибки по каналам двух изображений одного режима."""
    mses = []
    for band in range(len(a.getbands())):
        rms = ImageStat.Stat(ImageChops.difference(a.getchannel(band), b.getchannel(band))).rms[0]
        mses.append(rms * rms)
    return sum(mses) / len(mses)


def composite(im, bg=(128, 128, 128)):
    """RGBA на сером фоне: RGB под нулевой альфой (которое кодек свободно меняет) в оценку не входит."""
    base = Image.new('RGB', im.size, bg)
    base.paste(im.convert('RGB'), mask=im.getchannel('A'))
    return base


def quality(ref, out):
    """Строка качества: для RGB — PSNR; для RGBA — PSNR композита на сером фоне и PSNR альфы."""
    if 'A' in ref.getbands():
        comp = mse_to_psnr(band_mse(composite(ref), composite(out)))
        alpha = mse_to_psnr(band_mse(ref.getchannel('A').convert('RGB'), out.getchannel('A').convert('RGB')))
        return f'PSNR композит {comp:.1f} дБ, альфа {alpha:.1f} дБ'
    return f'PSNR {mse_to_psnr(band_mse(ref, out)):.1f} дБ'


def verify(src, dst, opts, ref):
    """Декодирует WebP и сверяет с оригиналом: без потерь — побитово, с потерями — по качеству."""
    out = Image.open(dst)
    out.load()
    if out.mode != ref.mode:
        out = out.convert(ref.mode)
    if opts.get('lossless'):
        identical = ImageChops.difference(ref, out).getbbox(alpha_only=False) is None
        return 'побитово совпадает' if identical else 'НЕ СОВПАДАЕТ'
    return quality(ref, out)


def reference(src):
    im = Image.open(src)
    im.load()
    has_alpha = ('A' in im.getbands()) or ('transparency' in im.info)
    return im.convert('RGBA' if has_alpha else 'RGB')


def convert_one(src, opts):
    dst = os.path.splitext(src)[0] + '.webp'
    if os.path.abspath(dst) == os.path.abspath(src):
        raise RuntimeError(f'выход совпал с оригиналом: {src}')
    ref = reference(src)
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        # WebP уже создан из этого оригинала: не пересоздаём, чтобы не плодить копии в rejected/
        return dst, verify(src, dst, opts, ref)
    retire(dst)
    ref.save(dst, 'WEBP', **opts)
    return dst, verify(src, dst, opts, ref)


def check_one(src, opts):
    dst = os.path.splitext(src)[0] + '.webp'
    if not os.path.exists(dst):
        raise RuntimeError(f'нет WebP для {rel(src)}: запустите без --check')
    return dst, verify(src, dst, opts, reference(src))


def num(n):
    return f'{n:,}'.replace(',', ' ')


def first_load(after):
    """Файлы первой загрузки по ТЗ 3.11 («Порядок загрузки»); tex_fallback и gold_1024 не входят.

    after=False: состав v1 из эталонного коммита 007cc11 (PNG, JPG, без данных).
    after=True: состав v2 из рабочей копии (WebP, данные, шрифты).
    """
    if after:
        files = [os.path.join(REPO, 'index.html'), os.path.join(REPO, 'ui.css'), os.path.join(REPO, 'ui.js'),
                 os.path.join(REPO, 'data', 'places.json'), os.path.join(REPO, 'data', 'strings.json'),
                 os.path.join(REPO, 'brand', 'strazhi_gold.webp')]
        files += sorted(glob.glob(os.path.join(REPO, 'sprites', '*.webp')))
        files += [os.path.join(REPO, f) for f in ('tex_parchment.webp', 'tex_relief.webp',
                                                  'tex_ink.webp', 'tex_mask.webp')]
        files += sorted(glob.glob(os.path.join(REPO, 'fonts', '*.woff2')))
    else:
        golden = os.path.join(MAP_DIR, 'tests', 'golden-src')
        files = [os.path.join(golden, 'index.html'),
                 os.path.join(golden, 'brand', 'strazhi_gold.png'), os.path.join(golden, 'brand', 'gold_1024.jpg'),
                 os.path.join(golden, 'tex_parchment.jpg'), os.path.join(golden, 'tex_relief.png'),
                 os.path.join(golden, 'tex_ink.png'), os.path.join(golden, 'tex_mask.png')]
        files += sorted(glob.glob(os.path.join(golden, 'sprites', '*.png')))
        files += sorted(glob.glob(os.path.join(golden, 'fonts', '*.woff2')))
    return [f for f in files if os.path.isfile(f)]


def sum_report(files):
    total = sum(os.path.getsize(f) for f in files)
    biggest = max(files, key=os.path.getsize) if files else None
    return total, len(files), biggest


def update_places_sprite_size(sizes):
    if not os.path.exists(PLACES):
        print('data/places.json ещё нет: spriteSize запишется при его создании')
        return
    with open(PLACES, encoding='utf-8') as f:
        old_text = f.read()
    data = json.loads(old_text)
    data['spriteSize'] = sizes
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if text == old_text:
        print('data/places.json: spriteSize без изменений')
        return
    retire(PLACES)
    with open(PLACES, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('data/places.json: обновлён spriteSize')


def sprite_sizes():
    sizes = {}
    for p in sorted(glob.glob(os.path.join(REPO, 'sprites', '*.png'))):
        with Image.open(p) as im:
            sizes[os.path.splitext(os.path.basename(p))[0]] = list(im.size)
    return sizes


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    check_only = '--check' in sys.argv[1:]
    if not features.check('webp'):
        sys.exit('Pillow собран без поддержки WebP: конвертируйте через sharp-cli (см. ASSETS.md)')

    print('| Файл | До, байт | После, байт | После / до | Параметры | Проверка |')
    print('|---|---:|---:|---:|---|---|')
    for src, opts, note in jobs():
        before = os.path.getsize(src)
        dst, check = check_one(src, opts) if check_only else convert_one(src, opts)
        after = os.path.getsize(dst)
        print(f'| `{rel(src)}` | {num(before)} | {num(after)} | {after / before:.0%} | {note} | {check} |')

    sizes = sprite_sizes()
    if check_only:
        if os.path.exists(PLACES):
            with open(PLACES, encoding='utf-8') as f:
                stored = json.load(f).get('spriteSize')
            print('spriteSize в data/places.json ' + ('совпадает с файлами' if stored == sizes
                                                    else 'НЕ совпадает с файлами sprites/*.png'))
    else:
        update_places_sprite_size(sizes)

    tb, nb, big_b = sum_report(first_load(False))
    ta, na, big_a = sum_report(first_load(True))
    print()
    print(f'Первая загрузка до (v1, эталон 007cc11): {tb / MB:.2f} МБ, запросов {nb}, '
          f'крупнейший {os.path.basename(big_b)} {os.path.getsize(big_b) / MB:.2f} МБ')
    print(f'Первая загрузка после (v2, рабочая копия сейчас): {ta / MB:.2f} МБ, запросов {na}, '
          f'крупнейший {os.path.basename(big_a)} {os.path.getsize(big_a) / MB:.2f} МБ')
    print('Цель ТЗ 3.11: не больше 4,00 МБ, ни один файл больше 1,30 МБ, запросов не больше 40')
    over = [f for f in first_load(True) if os.path.getsize(f) > 1.3 * MB]
    print('Файлы больше 1,3 МБ:', ', '.join(rel(f) for f in over) if over else 'нет')
    print('Состав первой загрузки после:')
    for f in first_load(True):
        print(f'  {rel(f)}  {num(os.path.getsize(f))}')


if __name__ == '__main__':
    main()
