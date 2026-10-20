// Проверка данных карты «Драконье побережье», версия 2: ТЗ раздел 4.4, проверки 1–5 (J1, J2).
// Node 18+, без зависимостей. Для режима без клона вики нужен fetch.
//
// Запуск из папки репозитория карты:
//   node tools/check-places.mjs
//   node tools/check-places.mjs --wiki "<путь к lore dwd/src/content>" --texts "<путь к TEXTS.md>"
//   (необязательно: --places <файл> --strings <файл> для проверки другой копии данных)
//   node tools/check-places.mjs --http        проверять пути вики HEAD-запросами, даже если клон есть
//
// Клон вики по умолчанию: ../../../lore dwd/src/content от корня репозитория (D:/Vibecoding/vibe/lore dwd).
// Код выхода: 0 — расхождений нет, 1 — есть ошибки. Предупреждения кода выхода не меняют.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SLUG_RE = /^[a-z0-9-]+$/;
const PATH_RE = /^\/[a-z0-9-]+\/[a-z0-9-]+\/(#[^#\s]+)?$/;
const KINDS = ['city', 'island', 'ship', 'sea'];
const STATUSES = ['article', 'section', 'master', 'show'];
const EXPECTED_PLACES = 14;
// Статусы мест, у которых в карточке нет строки статуса (решения заказчика 2026-10-20): master (нет в вики) и section (абзац в статье «Драконье Море»)
const NO_STATUS_LINE = ['master', 'section'];
// Группы указателя по местности (TEXTS.md раздел 5): значение поля group -> заголовок группы в TEXTS.md.
// Порядок ключей и есть порядок групп в указателе.
const GROUPS = { north: 'Север', mountains: 'Горы', sea: 'Море' };
// Порядок внутри группы, как его строит ui.js (renderIndex): море, потом острова и города по алфавиту, потом корабль
const kindRank = (p) => (p.kind === 'sea' ? 0 : p.kind === 'ship' ? 2 : 1);

function parseArgs(argv) {
  const out = {
    wiki: resolve(REPO, '../../../lore dwd/src/content'),
    texts: resolve(REPO, '../TEXTS.md'),
    places: join(REPO, 'data', 'places.json'),
    strings: join(REPO, 'data', 'strings.json'),
    http: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wiki') out.wiki = resolve(argv[++i]);
    else if (a === '--texts') out.texts = resolve(argv[++i]);
    else if (a === '--places') out.places = resolve(argv[++i]);
    else if (a === '--strings') out.strings = resolve(argv[++i]);
    else if (a === '--http') out.http = true;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------- разбор TEXTS.md
const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const stripTicks = (s) => {
  const m = /^`([^`]+)`$/.exec(s.trim());
  return m ? m[1] : s.trim();
};

function parseTexts(text) {
  const strings = new Map(); // ключ -> { value, source }, разделы 1–6
  const places = new Map(); // place.<слаг>.<поле> -> { value, source }, раздел 7
  const master = new Map(); // слаг -> { name, type, text, drawn }, раздел 7.6: слаг | name | type | text.1 | что нарисовано
  const groups = new Map(); // заголовок группы («Север») -> имена мест по порядку, строки «Север»: ... раздела 5
  let raw76 = ''; // весь текст раздела 7.6 (подписи островов стоят в абзаце под таблицей)
  let section = 0;
  let sub = '';
  for (const line of text.split('\n')) {
    let m = /^## (\d+)\./.exec(line);
    if (m) {
      section = Number(m[1]);
      sub = '';
      continue;
    }
    if (line.startsWith('## ')) {
      section = 0;
      sub = '';
      continue;
    }
    if (line.startsWith('### ')) {
      sub = line;
      continue;
    }
    if (sub.startsWith('### 7.6')) raw76 += `${line}\n`;
    if (section === 5 && (m = /^«([^»]+)»: (.+)\.$/.exec(line.trim()))) {
      if (groups.has(m[1])) throw new Error(`повтор группы в TEXTS.md: ${m[1]}`);
      groups.set(m[1], m[2].split(',').map((n) => n.trim()));
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    m = /^`([^`]+)`$/.exec(cells[0] ?? '');
    if (!m || cells.length < 2) continue;
    const key = m[1];
    if (sub.startsWith('### 7.6') && SLUG_RE.test(key)) {
      master.set(key, { name: cells[1], type: cells[2] ?? '', text: cells[3] ?? '', drawn: cells[4] ?? '' });
    } else if (key.startsWith('place.')) {
      if (places.has(key)) throw new Error(`повтор ключа в TEXTS.md: ${key}`);
      places.set(key, { value: cells[1], source: cells[2] ?? '' });
    } else if (section >= 1 && section <= 6) {
      if (strings.has(key)) throw new Error(`повтор ключа в TEXTS.md: ${key}`);
      strings.set(key, { value: cells[1], source: cells[2] ?? '' });
    }
  }
  const sevenAt = text.indexOf('\n## 7.');
  const wikiBase = sevenAt >= 0 ? /`(https:\/\/lore\.[^`]+)`/.exec(text.slice(sevenAt))?.[1] : undefined;
  return { strings, places, master, groups, raw76, wikiBase };
}

const parseWiki = (v) => {
  const out = { path: ticks(v)[0] };
  const f = /«([^»]+)»/.exec(v);
  if (f) out.textFragment = f[1];
  return out;
};

const parseRelated = (v) =>
  v.split(' · ').map((chunk) => {
    const i = chunk.indexOf(' → ');
    return { title: i < 0 ? '' : chunk.slice(0, i).trim(), path: ticks(i < 0 ? chunk : chunk.slice(i + 3))[0] };
  });

// ---------------------------------------------------------------- вспомогательное
const isInt = (n) => Number.isInteger(n);
const sameArray = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normQuotes = (s) => s.replace(/[«»“”„"]/g, '"').replace(/\s+/g, ' ').trim();

function frontmatter(text) {
  if (!text.startsWith('---')) return { title: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { title: null, body: text };
  const fm = text.slice(3, end);
  const m = /^title:\s*(.+)$/m.exec(fm);
  let title = m ? m[1].trim() : null;
  if (title && /^(["']).*\1$/.test(title)) title = title.slice(1, -1);
  return { title, body: text.slice(end + 4) };
}

const slugify = (h) =>
  h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

function headingIds(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) ids.add(slugify(m[1]));
  }
  return ids;
}

function pngSize(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`не PNG: ${file}`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

// ---------------------------------------------------------------- проверка 1: поля, слаги, алиасы
function check1(data, errors) {
  const top = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  top(data.version === 2, 'version должен быть 2');
  top(/^\d{4}-\d{2}-\d{2}$/.test(data.checked ?? ''), 'checked должен быть датой ГГГГ-ММ-ДД');
  for (const k of ['wikiBase', 'taplink', 'youtube']) {
    top(typeof data[k] === 'string' && data[k].startsWith('https://'), `${k}: нужен https-адрес`);
  }
  top(data.wikiBase === 'https://lore.xn--80agogbaiw1akdl8m.xn--p1ai', 'wikiBase не совпадает с адресом вики');

  const sizes = data.spriteSize ?? {};
  for (const [name, wh] of Object.entries(sizes)) {
    top(Array.isArray(wh) && wh.length === 2 && wh.every((n) => isInt(n) && n > 0), `spriteSize.${name}: нужны [ширина, высота]`);
  }
  const pngs = readdirSync(join(REPO, 'sprites')).filter((f) => f.toLowerCase().endsWith('.png'));
  for (const f of pngs) {
    const name = f.replace(/\.png$/i, '');
    if (!(name in sizes)) errors.push(`spriteSize: нет записи для sprites/${f}`);
    else {
      const [w, h] = pngSize(join(REPO, 'sprites', f));
      if (sizes[name][0] !== w || sizes[name][1] !== h) errors.push(`spriteSize.${name}: записано ${sizes[name]}, в файле ${w}×${h}`);
    }
  }
  for (const name of Object.keys(sizes)) {
    if (!pngs.includes(`${name}.png`)) errors.push(`spriteSize.${name}: нет файла sprites/${name}.png`);
  }

  const places = Array.isArray(data.places) ? data.places : [];
  top(places.length === EXPECTED_PLACES, `мест должно быть ${EXPECTED_PLACES}, найдено ${places.length}`);

  const slugs = new Set();
  for (const p of places) {
    const w = `место ${p.slug ?? '?'}`;
    if (typeof p.slug !== 'string' || !SLUG_RE.test(p.slug)) errors.push(`${w}: слаг должен быть a-z0-9-`);
    else if (slugs.has(p.slug)) errors.push(`${w}: повтор слага`);
    else slugs.add(p.slug);
  }
  const aliasSeen = new Map();
  for (const p of places) {
    for (const a of p.aliases ?? []) {
      const w = `место ${p.slug}: алиас ${a}`;
      if (!SLUG_RE.test(a)) errors.push(`${w}: формат a-z0-9-`);
      if (slugs.has(a)) errors.push(`${w} совпадает со слагом места`);
      if (aliasSeen.has(a)) errors.push(`${w} уже занят местом ${aliasSeen.get(a)}`);
      aliasSeen.set(a, p.slug);
    }
  }

  for (const p of places) {
    const w = `место ${p.slug}`;
    if (!Array.isArray(p.aliases)) errors.push(`${w}: aliases должен быть массивом`);
    if (!KINDS.includes(p.kind)) errors.push(`${w}: kind ${p.kind} не из ${KINDS.join(', ')}`);
    if (!STATUSES.includes(p.status)) errors.push(`${w}: status ${p.status} не из ${STATUSES.join(', ')}`);
    if (p.kind === 'sea' && p.status !== 'article') errors.push(`${w}: море должно иметь status article`);
    if (p.kind === 'ship' && p.status !== 'show') errors.push(`${w}: корабль должен иметь status show`);
    if (p.kind === 'island' && p.status !== 'master') errors.push(`${w}: остров должен иметь status master`);
    if (p.kind === 'city' && p.status === 'show') errors.push(`${w}: город не может иметь status show`);
    for (const f of ['name', 'label', 'type']) {
      if (typeof p[f] !== 'string' || !p[f].trim()) errors.push(`${w}: нет поля ${f}`);
    }
    if (!Array.isArray(p.sources) || p.sources.length === 0) errors.push(`${w}: нужен sources (массив)`);
    if (p.ruler !== undefined && typeof p.ruler !== 'string') errors.push(`${w}: ruler должен быть строкой`);

    const master = p.status === 'master';
    const hasWiki = p.status === 'article' || p.status === 'section';

    // решение заказчика 2026-10-20: описание (text) есть у всех мест, в том числе у master; группа указателя обязательна
    if (!Array.isArray(p.text) || p.text.length === 0 || p.text.some((t) => typeof t !== 'string' || !t.trim())) {
      errors.push(`${w}: text должен быть непустым массивом строк`);
    }
    if (typeof p.group !== 'string' || !Object.hasOwn(GROUPS, p.group)) errors.push(`${w}: group ${p.group} не из ${Object.keys(GROUPS).join(', ')}`);
    if (master) {
      if (p.wiki !== undefined) errors.push(`${w}: у master не должно быть wiki`);
      if (p.related !== undefined) errors.push(`${w}: у master не должно быть related`);
    } else if (!Array.isArray(p.related) || p.related.length === 0) errors.push(`${w}: нужен related (массив)`);
    if (hasWiki) {
      if (!p.wiki || typeof p.wiki.path !== 'string') errors.push(`${w}: нужен wiki.path`);
      else if (!PATH_RE.test(p.wiki.path)) errors.push(`${w}: путь вики ${p.wiki.path} без слеша в конце`);
    }
    for (const r of p.related ?? []) {
      if (!r || typeof r.title !== 'string' || typeof r.path !== 'string') errors.push(`${w}: related без title или path`);
      else if (!PATH_RE.test(r.path)) errors.push(`${w}: путь related ${r.path} без слеша в конце`);
    }
    if (p.kind === 'ship') {
      if (typeof p.link !== 'string' || !p.link.startsWith('https://')) errors.push(`${w}: у корабля нужна ссылка link`);
      if (typeof p.shareName !== 'string') errors.push(`${w}: у корабля нужен shareName`);
    }

    const m = p.map ?? {};
    if (p.kind === 'sea') {
      if (m.seaLabel !== true) errors.push(`${w}: у моря map.seaLabel должен быть true`);
    } else if (p.kind === 'ship') {
      if (m.ship !== 0) errors.push(`${w}: у корабля map.ship должен быть 0 (индекс в SHIPS)`);
    } else if (p.kind === 'island') {
      if (!isInt(m.x) || !isInt(m.y) || m.fs !== 40) errors.push(`${w}: у острова map нужен {x, y, fs: 40}`);
    } else {
      if (!isInt(m.x) || !isInt(m.y) || !isInt(m.w) || !isInt(m.fs) || typeof m.sprite !== 'string') {
        errors.push(`${w}: у города map нужен {x, y, sprite, w, fs}`);
      } else {
        if (!(m.sprite in sizes)) errors.push(`${w}: спрайт ${m.sprite} нет в spriteSize`);
        for (const ext of ['png', 'webp']) {
          if (!existsSync(join(REPO, 'sprites', `${m.sprite}.${ext}`))) errors.push(`${w}: нет файла sprites/${m.sprite}.${ext}`);
        }
      }
    }
  }
  for (const g of Object.keys(GROUPS)) {
    if (places.length === EXPECTED_PLACES && !places.some((p) => p.group === g)) errors.push(`группа ${g} («${GROUPS[g]}») пуста`);
  }
  return { places: places.length, aliases: aliasSeen.size };
}

// ---------------------------------------------------------------- проверки 2–4: вики
async function checkWiki(data, opts, errors, notes) {
  const useClone = !opts.http && existsSync(opts.wiki) && statSync(opts.wiki).isDirectory();
  const paths = new Set();
  for (const p of data.places ?? []) {
    if (p.wiki) paths.add(p.wiki.path);
    for (const r of p.related ?? []) paths.add(r.path);
  }
  let files = 0;
  let anchors = 0;
  const texts = new Map();
  for (const path of paths) {
    const [base, anchor] = path.split('#');
    if (useClone) {
      const [, collection, slug] = base.split('/');
      const file = join(opts.wiki, collection, `${slug}.md`);
      if (!existsSync(file)) {
        errors.push(`путь ${path}: нет файла ${collection}/${slug}.md в клоне вики`);
        continue;
      }
      files++;
      if (anchor) {
        anchors++;
        if (!headingIds(readFileSync(file, 'utf8')).has(decodeURIComponent(anchor))) {
          errors.push(`путь ${path}: якорь #${anchor} не найден среди заголовков статьи`);
        }
      }
    } else {
      const url = data.wikiBase + base;
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
        if (res.status !== 200) errors.push(`${url}: HEAD ответил ${res.status}, нужен 200`);
        else files++;
      } catch (e) {
        errors.push(`${url}: нет ответа (${e.cause?.code ?? e.message})`);
      }
    }
  }
  if (useClone) {
    // проверки 3 и 4 — по клону
    let titles = 0;
    let fragments = 0;
    for (const p of data.places ?? []) {
      for (const r of p.related ?? []) {
        const [base] = r.path.split('#');
        const [, collection, slug] = base.split('/');
        const file = join(opts.wiki, collection, `${slug}.md`);
        if (!existsSync(file)) continue;
        const { title } = frontmatter(readFileSync(file, 'utf8'));
        titles++;
        if (title === null) errors.push(`связанная статья ${r.path}: нет title во frontmatter`);
        else if (normQuotes(title) !== normQuotes(r.title)) {
          errors.push(`связанная статья ${r.path}: в data «${r.title}», в вики «${title}»`);
        }
      }
      if (p.wiki?.textFragment !== undefined) {
        const [base] = p.wiki.path.split('#');
        const [, collection, slug] = base.split('/');
        const file = join(opts.wiki, collection, `${slug}.md`);
        if (!existsSync(file)) continue;
        let body = texts.get(file);
        if (body === undefined) {
          body = frontmatter(readFileSync(file, 'utf8')).body;
          texts.set(file, body);
        }
        const f = p.wiki.textFragment;
        const count = body.split(f).length - 1;
        fragments++;
        if (count === 0) errors.push(`${p.slug}: текстовый якорь «${f}» не найден в ${collection}/${slug}.md`);
        else if (count > 1) notes.push(`${p.slug}: текстовый якорь «${f}» встречается ${count} раз`);
      }
    }
    notes.push(`клон вики: ${opts.wiki}`);
    return { mode: 'клон', files, anchors, titles, fragments };
  }
  notes.push('клон вики не найден, пути проверены HEAD-запросами (якоря и заголовки не проверялись)');
  return { mode: 'HTTP', files, anchors, titles: 0, fragments: 0 };
}

// ---------------------------------------------------------------- проверка 5: TEXTS.md
function check5(data, texts, errors) {
  const dataStrings = data.stringsJson;
  const expectStrings = [...texts.strings.keys()];
  for (const k of expectStrings) {
    if (!(k in dataStrings)) errors.push(`strings.json: нет ключа ${k}`);
    else if (dataStrings[k] !== texts.strings.get(k).value) {
      errors.push(`strings.json ${k}: «${dataStrings[k]}» ≠ TEXTS «${texts.strings.get(k).value}»`);
    }
  }
  for (const k of Object.keys(dataStrings)) {
    if (!texts.strings.has(k)) errors.push(`strings.json: лишний ключ ${k} (нет в TEXTS.md, разделы 1–6)`);
  }
  // Строка статуса в карточке выводится, только если для статуса места есть строка card.status.<статус> в strings.json.
  // Решения заказчика 2026-10-20: у master и section её нет (см. TEXTS.md раздел 6), у остальных статусов есть.
  for (const s of new Set((data.places ?? []).map((p) => p.status))) {
    const has = `card.status.${s}` in dataStrings;
    if (NO_STATUS_LINE.includes(s) && has) errors.push(`strings.json: есть card.status.${s}, а у статуса ${s} строки статуса быть не должно`);
    if (!NO_STATUS_LINE.includes(s) && !has) errors.push(`strings.json: нет card.status.${s}, а у статуса ${s} строка статуса должна быть`);
  }

  const tSlugs = new Set([...texts.places.keys()].map((k) => k.split('.')[1]));
  for (const slug of texts.master.keys()) tSlugs.add(slug);
  const dSlugs = new Set((data.places ?? []).map((p) => p.slug));
  for (const s of tSlugs) if (!dSlugs.has(s)) errors.push(`places.json: нет места ${s} из TEXTS.md`);
  for (const s of dSlugs) if (!tSlugs.has(s)) errors.push(`places.json: место ${s} нет в TEXTS.md`);

  const byslug = new Map((data.places ?? []).map((p) => [p.slug, p]));
  for (const slug of tSlugs) {
    const p = byslug.get(slug);
    if (!p) continue;
    const w = `место ${slug}`;
    const get = (f) => texts.places.get(`place.${slug}.${f}`)?.value;

    if (texts.master.has(slug)) {
      const m = texts.master.get(slug);
      if (p.status !== 'master') errors.push(`${w}: status должен быть master`);
      if (p.name !== m.name) errors.push(`${w}: name «${p.name}» ≠ TEXTS «${m.name}»`);
      if (p.type !== m.type) errors.push(`${w}: type «${p.type}» ≠ TEXTS «${m.type}»`);
      // описание вместо прежней строки «В вики об этом месте пока ничего нет»: один абзац из 7.6 (столбец text.1), слово в слово
      if (!m.text) errors.push(`${w}: в TEXTS.md 7.6 нет text.1`);
      else if (!sameArray(p.text, [m.text])) errors.push(`${w}: text ${JSON.stringify(p.text)} ≠ TEXTS 7.6 «${m.text}»`);
      if (p.kind === 'island') {
        // на карте остров подписан «о. Эвалия»; сама подпись стоит в абзаце под таблицей 7.6
        if (p.label !== `о. ${m.name}`) errors.push(`${w}: подпись на карте «${p.label}» ≠ «о. ${m.name}»`);
        if (!texts.raw76.includes(`«${p.label}»`)) errors.push(`${w}: подпись «${p.label}» не найдена в TEXTS.md 7.6`);
      } else if (p.label !== m.name) errors.push(`${w}: подпись «${p.label}» ≠ имя «${m.name}»`);
      continue;
    }

    if (p.name !== get('name')) errors.push(`${w}: name «${p.name}» ≠ TEXTS «${get('name')}»`);
    if (p.type !== get('type')) errors.push(`${w}: type «${p.type}» ≠ TEXTS «${get('type')}»`);
    if (p.status !== stripTicks(get('status'))) errors.push(`${w}: status ${p.status} ≠ TEXTS ${get('status')}`);
    if (get('ruler') !== undefined ? p.ruler !== get('ruler') : p.ruler !== undefined) {
      errors.push(`${w}: ruler не совпадает с TEXTS`);
    }
    const textKeys = [1, 2, 3].filter((i) => texts.places.has(`place.${slug}.text.${i}`));
    const expectText = textKeys.map((i) => texts.places.get(`place.${slug}.text.${i}`).value);
    if (!sameArray(p.text, expectText)) errors.push(`${w}: абзацы text не совпадают с TEXTS (${expectText.length} в TEXTS)`);

    if (get('wiki') !== undefined) {
      const e = parseWiki(get('wiki'));
      if (p.wiki?.path !== e.path) errors.push(`${w}: wiki.path ${p.wiki?.path} ≠ TEXTS ${e.path}`);
      if (p.wiki?.textFragment !== e.textFragment) errors.push(`${w}: textFragment «${p.wiki?.textFragment}» ≠ TEXTS «${e.textFragment}»`);
    } else if (p.wiki !== undefined) errors.push(`${w}: wiki есть в данных, в TEXTS нет`);

    if (get('related') !== undefined) {
      const e = parseRelated(get('related'));
      const ok = Array.isArray(p.related) && p.related.length === e.length &&
        e.every((x, i) => p.related[i].title === x.title && p.related[i].path === x.path);
      if (!ok) errors.push(`${w}: связанные статьи не совпадают с TEXTS`);
    } else if (p.related !== undefined) errors.push(`${w}: related есть в данных, в TEXTS нет`);

    if (get('shareName') !== undefined ? p.shareName !== get('shareName') : p.shareName !== undefined) {
      errors.push(`${w}: shareName не совпадает с TEXTS`);
    }
    if (get('link') !== undefined) {
      const url = ticks(get('link')).find((t) => t.startsWith('https://'));
      if (p.link !== url) errors.push(`${w}: link ${p.link} ≠ TEXTS ${url}`);
    }

    if (p.kind === 'sea') {
      if (!texts.raw.includes(`«${p.label}»`)) errors.push(`${w}: подпись «${p.label}» не найдена в TEXTS.md`);
    } else if (p.label !== p.name) errors.push(`${w}: подпись «${p.label}» ≠ имя «${p.name}»`);
  }

  // группы указателя (раздел 5): состав, поле group и порядок внутри группы
  const placeByName = new Map((data.places ?? []).map((p) => [p.name, p]));
  const inGroups = new Set();
  for (const [g, title] of Object.entries(GROUPS)) {
    const names = texts.groups.get(title);
    if (!names) {
      errors.push(`TEXTS.md раздел 5: нет строки группы «${title}»`);
      continue;
    }
    for (const n of names) {
      const p = placeByName.get(n);
      if (!p) errors.push(`группа «${title}»: места «${n}» нет в places.json`);
      else if (inGroups.has(n)) errors.push(`группа «${title}»: «${n}» названо в TEXTS.md второй раз`);
      else if (p.group !== g) errors.push(`место ${p.slug}: group ${p.group} ≠ ${g} (TEXTS.md: «${title}»)`);
      inGroups.add(n);
    }
    const built = (data.places ?? []).filter((p) => p.group === g)
      .sort((a, b) => kindRank(a) - kindRank(b) || a.name.localeCompare(b.name, 'ru')).map((p) => p.name);
    if (!sameArray(built, names)) errors.push(`группа «${title}»: указатель выстроит ${built.join(', ')}, в TEXTS.md ${names.join(', ')}`);
  }
  for (const title of texts.groups.keys()) {
    if (!Object.values(GROUPS).includes(title)) errors.push(`TEXTS.md раздел 5: лишняя группа «${title}»`);
  }
  for (const p of data.places ?? []) {
    if (!inGroups.has(p.name)) errors.push(`место ${p.slug}: «${p.name}» нет ни в одной группе TEXTS.md (раздел 5)`);
  }

  const yt = /https:\/\/www\.youtube\.com\/@[^`\s)]+/.exec(texts.strings.get('card.showLink')?.source ?? '')?.[0];
  if (data.youtube !== yt) errors.push(`youtube ${data.youtube} ≠ TEXTS ${yt}`);
  const tap = /taplink\.cc\/[^`\s)]+/.exec(texts.strings.get('links.show')?.source ?? '')?.[0];
  if (data.taplink !== `https://${tap}`) errors.push(`taplink ${data.taplink} ≠ TEXTS ${tap}`);
  if (texts.wikiBase !== data.wikiBase) errors.push(`wikiBase ${data.wikiBase} ≠ TEXTS ${texts.wikiBase}`);
  return { strings: expectStrings.length, places: tSlugs.size, groups: texts.groups.size };
}

// ---------------------------------------------------------------- запуск
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawTexts = readFileSync(opts.texts, 'utf8');
  const texts = parseTexts(rawTexts);
  texts.raw = rawTexts;
  const data = JSON.parse(readFileSync(opts.places, 'utf8'));
  data.stringsJson = JSON.parse(readFileSync(opts.strings, 'utf8'));

  const report = [];
  const errs = { s1: [], s2: [], s5: [] };
  const notes = [];

  const s1 = check1(data, errs.s1);
  report.push(`[1] поля, слаги, алиасы, группы: ${errs.s1.length ? 'FAIL' : 'OK'} (мест ${s1.places}, алиасов ${s1.aliases})`);

  const wiki = await checkWiki(data, opts, errs.s2, notes);
  report.push(`[2–4] вики: ${errs.s2.length ? 'FAIL' : 'OK'} (режим ${wiki.mode}: статей-путей ${wiki.files}, якорей ${wiki.anchors}, связанных названий ${wiki.titles}, текстовых якорей ${wiki.fragments})`);

  const s5 = check5(data, texts, errs.s5);
  report.push(`[5] TEXTS.md: ${errs.s5.length ? 'FAIL' : 'OK'} (строк интерфейса ${s5.strings}, мест ${s5.places}, групп указателя ${s5.groups})`);

  const all = [...errs.s1, ...errs.s2, ...errs.s5];
  console.log(report.join('\n'));
  for (const n of notes) console.log(`  заметка: ${n}`);
  for (const e of all) console.log(`  ОШИБКА: ${e}`);
  console.log(all.length ? `ИТОГ: ошибок ${all.length}, код 1` : 'ИТОГ: расхождений нет, код 0');
  process.exitCode = all.length ? 1 : 0;
}

main().catch((e) => {
  console.error(`ОШИБКА: ${e.stack || e}`);
  process.exitCode = 1;
});
