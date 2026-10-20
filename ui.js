/* Интерфейс карты «Драконье побережье»: раскладка, камера, ввод, панель и карточка, указатель, ссылки.
   Грузится только в интерактивном режиме (в ?video его нет). Движок отдаёт window.DCM, см. index.html.
   Все видимые строки приходят из data/strings.json и data/places.json; в коде их нет. */
(function () {
  'use strict';
  const D = document, W = window;
  const $ = (s, r) => (r || D).querySelector(s);
  const $$ = (s, r) => [...(r || D).querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const AR = 3372 / 1947;               // пропорция листа
  const SHEET_W = 3372, OFF_X = 150, OFF_Y = 110;   // лист в единицах SVG и сдвиг карты на нём
  const UTM = false;                    // ТЗ 4.3: метки не ставим, пока заказчик не подключит Метрику
  const MAX_Z = 4;
  const PEEK_H = 64, BAR_H = 48, RAIL = 44, RAIL_GAP = 12, PAD = 16;
  const store = {
    get(area, k) { try { return W[area].getItem(k); } catch (e) { return null; } },
    set(area, k, v) { try { W[area].setItem(k, v); } catch (e) {} },
  };

  /* ---------------- состояние ---------------- */
  let E = null;                          // движок (window.DCM)
  let STR = {}, META = {}, LIST = [], BY = new Map(), ALIAS = new Map(), dataOk = false;
  let layout = 'wide', geo = null;       // раскладка и геометрия листа
  const cam = { z: 1, tx: 0, ty: 0 };    // камера: масштаб и сдвиг в CSS px относительно #scroll
  let flying = false, flyTimer = 0, reduced = false, coarse = false;
  let els = {};                          // узлы интерфейса
  const S = { place: null, view: 'index', state: 'closed', fromIndex: false, pushed: false, opener: null, kbd: false, cardSlug: null };
  let sheetVis = 0, sheetTimer = 0, openH = 0;   // высота листа сейчас и измеренная высота карточки
  let hoverSlug = null, tipTimer = 0, tipSlug = null, lastTap = null;
  const pendingToasts = [];
  let chromeOn = false, coachShown = false;

  /* ---------------- мелочи ---------------- */
  function h(tag, props, kids) {
    const e = D.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k]; if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(c => { if (c != null && c !== false) e.append(c); });
    return e;
  }
  // строки, которые лежат прямо в index.html на случай, когда data/strings.json не загрузился (внутри <template>)
  const staticStr = key => { const tpl = D.getElementById('static-strings'), n = tpl && tpl.content.querySelector(`[data-key="${key}"]`); return n ? n.textContent : null; };
  function t(key, vars) {
    let s = STR[key]; if (s == null) s = staticStr(key); if (s == null) return '';
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k] != null ? vars[k] : m) : s;
  }
  const ICON = {
    plus: 'M10 4v12M4 10h12', minus: 'M4 10h12',
    fit: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4',
    pause: 'M7.5 4v12M12.5 4v12',
    wave: 'M2 7.5c1.7-2 3.3-2 5 0s3.3 2 5 0 3.3-2 6 0M2 12.5c1.7-2 3.3-2 5 0s3.3 2 5 0 3.3-2 6 0',
    link: 'M8.2 11.8l3.6-3.6M7.4 8.6L6 10a3 3 0 004.2 4.2l1.4-1.4M12.6 11.4L14 10a3 3 0 00-4.2-4.2L8.4 7.2',
    chevron: 'M5 12l5-5 5 5', back: 'M16 10H4m5-5l-5 5 5 5',
  };
  const svg = (name, size) => `<svg class="icon icon--${name}" width="${size || 20}" height="${size || 20}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICON[name]}"/></svg>`;
  const ext = () => h('span', { class: 'ext', 'aria-hidden': 'true', text: ' ↗' });
  const sortRu = (a, b) => a.name.localeCompare(b.name, 'ru');

  /* ---------------- геометрия: режим раскладки, бумага, окно V (ТЗ 5, 3.2) ---------------- */
  let safeProbe = null;
  function readSafe() {
    if (!safeProbe) {
      safeProbe = h('div', { 'aria-hidden': 'true' });
      safeProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      D.body.append(safeProbe);
    }
    const cs = getComputedStyle(safeProbe), n = p => parseFloat(cs[p]) || 0;
    return { t: n('paddingTop'), r: n('paddingRight'), b: n('paddingBottom'), l: n('paddingLeft') };
  }
  function pickLayout(vw, vh) {
    if (vh < 31.25 * 16) return 'landscape';
    if (vw >= 64 * 16) return 'wide';
    return vw > vh ? 'medium' : 'portrait';
  }
  function computeGeo() {
    const vw = W.innerWidth, vh = W.innerHeight, sa = readSafe(), lay = pickLayout(vw, vh);
    let w, hh, left, top, scene;
    if (lay === 'wide' || lay === 'medium') {
      const g = lay === 'wide' ? 24 : 16, Ht = lay === 'wide' ? 120 : 64, Hb = lay === 'wide' ? 72 : 80;
      w = Math.min((vw - 2 * g) / 1.254, (vh - 2 * Math.max(Ht, Hb)) * AR, (vh - 2 * g) / 1.6828 * AR);
      w = Math.max(w, 120); hh = w / AR; left = (vw - w) / 2; top = (vh - hh) / 2;
    } else if (lay === 'portrait') {
      const y0 = BAR_H + sa.t, y1 = vh - (PEEK_H + sa.b), stageH = Math.max(y1 - y0, 80);
      hh = stageH; w = hh * AR; left = (vw - w) / 2; top = y0;   // заказчик 2026-10-20: карта сразу на весь экран, потолка 640 px нет; отдалить можно до всей ширины бумаги (minZ)
      scene = { x0: 0, y0, x1: vw, y1 };
    } else {
      const stageW = vw - (Math.max(RAIL_GAP, sa.r) + RAIL) - RAIL_GAP - sa.l, stageH = vh - sa.t - sa.b;
      hh = Math.max(stageH - 16, 80); w = Math.min(hh * AR, (stageW - 16) / 1.254); w = Math.max(w, 120); hh = w / AR;
      left = sa.l + (stageW - w) / 2; top = sa.t + (stageH - hh) / 2;
    }
    const k = w / SHEET_W, paper = { left, top, w, h: hh };
    // видимое окно V в координатах бумаги: пересечение бумаги со сценой
    const V = scene
      ? { x0: Math.max(0, scene.x0 - left), y0: Math.max(0, scene.y0 - top), x1: Math.min(w, scene.x1 - left), y1: Math.min(hh, scene.y1 - top) }
      : { x0: 0, y0: 0, x1: w, y1: hh };
    return { layout: lay, vw, vh, sa, paper, k, V };
  }
  // Подписи на карте (QA v2, B4 и B5): на узкой бумаге они мельчали (альбом 844×390: 7,2 px, окно 1024: 8,8 px при 10,4 px на 1440×900).
  // Множитель к кеглям подписей на суше и у островов и корабля (ui.css, --lbl-k): на экране они не мельче, чем на бумаге шириной LBL_REF_W,
  // но не больше чем в LBL_MAX раз, иначе у подписей кончаются свободные места. Шаг 0,05: при плавном ресайзе подписи не пересчитываются каждый кадр.
  const LBL_REF_W = 877, LBL_MAX = 1.45;
  let lblK = 1;
  const labelScale = g => Math.round(clamp(LBL_REF_W / g.paper.w, 1, LBL_MAX) * 20) / 20;
  function applyGeo(g) {
    const r = D.documentElement;
    lblK = labelScale(g); r.style.setProperty('--lbl-k', String(lblK));
    r.style.setProperty('--paper-w', g.paper.w.toFixed(2) + 'px'); r.style.setProperty('--paper-h', g.paper.h.toFixed(2) + 'px');
    r.style.setProperty('--paper-left', g.paper.left.toFixed(2) + 'px'); r.style.setProperty('--paper-top', g.paper.top.toFixed(2) + 'px');
    r.style.setProperty('--panel-w', panelWidth(g) + 'px');
    r.dataset.layout = g.layout;
  }
  const panelWidth = g => g.layout === 'landscape' ? 300 : Math.round(clamp(0.26 * g.vw, 320, 400));
  const sidePanel = () => layout === 'wide' || layout === 'landscape';
  const sheetMode = () => layout === 'medium' || layout === 'portrait';
  const panelLeft = g => g.layout === 'landscape'
    ? g.vw - (Math.max(RAIL_GAP, g.sa.r) + RAIL + RAIL_GAP) - 300 : g.vw - 16 - panelWidth(g);

  /* ---------------- высота нижнего листа ---------------- */
  function sheetHeight(state) {
    if (state === 'closed') return 0;
    if (state === 'peek') return PEEK_H + geo.sa.b;
    if (state === 'half') return Math.min(.5 * geo.vh, 440);
    return clamp(openH || 320, 160, .7 * geo.vh);
  }
  // Что закрывает панель или лист в состоянии state: прямоугольник в клиентских координатах или null
  function cover(state) {
    if (state === 'closed' || state === 'peek') return null;
    if (sidePanel()) { const x0 = panelLeft(geo); return { x0, y0: 0, x1: geo.vw, y1: geo.vh }; }
    return { x0: 0, y0: geo.vh - sheetHeight(state), x1: geo.vw, y1: geo.vh };
  }
  // Окно камеры: V минус закрытое панелью (pad = 0 для ограничения, 16 для центрирования)
  function windowFor(state, pad) {
    const V = geo.V, p = geo.paper, c = cover(state), w = { x0: V.x0, y0: V.y0, x1: V.x1, y1: V.y1 };
    if (c) {
      if (sidePanel()) w.x1 = Math.min(w.x1, c.x0 - pad - p.left); else w.y1 = Math.min(w.y1, c.y0 - pad - p.top);
      w.x1 = Math.max(w.x1, w.x0 + 60); w.y1 = Math.max(w.y1, w.y0 + 60);
    }
    return w;
  }
  const clampWin = () => windowFor(S.state, 0);
  const freeWin = state => windowFor(state || S.state, PAD);

  /* ---------------- камера ---------------- */
  // Минимальный масштаб. В portrait бумага при z = 1 занимает всю высоту сцены и шире экрана: отдалить можно до того, как вся бумага
  // поместится по ширине экрана (карта целиком полосой по центру). В остальных раскладках минимум 1, как было.
  const minZ = () => layout === 'portrait' && geo ? Math.min(1, (geo.V.x1 - geo.V.x0) / geo.paper.w) : 1;
  function clampCam(z, tx, ty, win) {
    win = win || clampWin(); const p = geo.paper;
    z = clamp(z, minZ(), MAX_Z);
    // бумага меньше окна по оси: стоит по центру окна; иначе край бумаги не уходит внутрь окна
    const along = (t, size, a0, a1) => size <= a1 - a0 + 1e-6 ? (a0 + a1 - size) / 2 : clamp(t, a1 - size, a0);
    return { z, tx: along(tx, p.w * z, win.x0, win.x1), ty: along(ty, p.h * z, win.y0, win.y1) };
  }
  function applyCam(ms, ease) {
    const vp = E.els.vp;
    clearTimeout(flyTimer);
    if (ms && !reduced) {
      vp.style.transition = `transform ${ms}ms ${ease || 'var(--ease-out)'}`;
      flying = true; flyTimer = setTimeout(() => { flying = false; vp.style.transition = 'none'; }, ms + 60);
    } else { vp.style.transition = 'none'; flying = false; }
    vp.style.transform = `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.z})`;
    syncButtons();
    if (Math.abs(cam.z - hitZ) > 1e-3) sizeHits();
  }
  // Зона нажатия места не меньше 44×44 CSS px при любом масштабе (ТЗ 5.6); соседние зоны разводит placeAt по ближайшему якорю
  let hitZ = 0;
  function sizeHits() {
    if (!E || !E.placeEls.size || !geo) return;
    hitZ = cam.z;
    const m = 44 / (geo.k * cam.z);
    for (const e of E.placeEls.values()) {
      // hit: основная зона места; hit2: вторая зона (подпись корабля, QA v2 B1), у неё своя исходная рамка hb2
      for (const [k, kb] of [['hit', 'hb'], ['hit2', 'hb2']]) {
        const r = e[k]; if (!r) continue;
        if (!e[kb]) e[kb] = { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') };
        const b = e[kb], w = Math.max(b.w, m), hh = Math.max(b.h, m);
        r.setAttribute('x', b.x - (w - b.w) / 2); r.setAttribute('y', b.y - (hh - b.h) / 2);
        r.setAttribute('width', w); r.setAttribute('height', hh);
      }
    }
  }
  function setCam(z, tx, ty, ms, ease, win) {
    const c = clampCam(z, tx, ty, win); cam.z = c.z; cam.tx = c.tx; cam.ty = c.ty; applyCam(ms, ease);
  }
  // Любой ввод во время полёта останавливает его в текущей точке (читается матрица из getComputedStyle)
  function interrupt() {
    if (!flying) return;
    const m = new DOMMatrix(getComputedStyle(E.els.vp).transform);
    cam.z = m.a; cam.tx = m.e; cam.ty = m.f; applyCam(0);
  }
  function liveCam() {
    if (!flying) return cam;
    const m = new DOMMatrix(getComputedStyle(E.els.vp).transform); return { z: m.a, tx: m.e, ty: m.f };
  }
  const centerOf = w => ({ x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 });
  // «Вся карта»: минимальный масштаб (в portrait вся бумага по ширине экрана, иначе 1), лист по центру окна
  function fitCam(ms) {
    const c = centerOf(geo.V), p = geo.paper, z = minZ();
    setCam(z, c.x - p.w * z / 2, c.y - p.h * z / 2, ms, 'var(--ease-out)');
  }
  // Начальное положение (первый показ, «Развернуть карту заново»): масштаб 1, лист по центру; в portrait карта сразу закрывает весь экран
  function startCam() {
    const c = centerOf(geo.V), p = geo.paper;
    setCam(1, c.x - p.w / 2, c.y - p.h / 2, 0, 'var(--ease-out)');
  }
  // Масштаб вокруг точки экрана (cx, cy)
  function zoomAt(cx, cy, factor, ms) {
    const lc = liveCam(); if (flying) { cam.z = lc.z; cam.tx = lc.tx; cam.ty = lc.ty; }
    const p = geo.paper, mx = cx - p.left, my = cy - p.top, z0 = cam.z, z1 = clamp(z0 * factor, minZ(), MAX_Z);
    setCam(z1, mx - (mx - cam.tx) * z1 / z0, my - (my - cam.ty) * z1 / z0, ms);
  }
  function zoomStep(f) {
    interrupt();
    const w = freeWin(), c = centerOf(w), p = geo.paper;
    zoomAt(p.left + c.x, p.top + c.y, f, 220);
  }
  function panBy(dx, dy, ms) { interrupt(); setCam(cam.z, cam.tx + dx, cam.ty + dy, ms); }
  // Точка карты (единицы SVG) в координатах бумаги при Z = 1
  const toPaper = a => ({ x: (a.x + OFF_X) * geo.k, y: (a.y + OFF_Y) * geo.k });
  function anchorPaper(slug) { const a = E.anchor(slug); return a ? toPaper(a) : null; }
  function flyTo(slug, state, ms) {
    const p = BY.get(slug), a = anchorPaper(slug); if (!a) return;
    const fw = freeWin(state), fc = centerOf(fw), win = windowFor(state, 0);
    let z, tx, ty;
    if (p.kind === 'sea') {
      z = 1; tx = fc.x - geo.paper.w / 2; ty = fc.y - geo.paper.h / 2;   // «Вся карта»: лист по центру свободной области
      // но подпись моря остаётся на виду, даже если центр листа её увёл (телефон, высокий лист)
      const m = 24, sx = a.x + tx, sy = a.y + ty;
      if (sx < fw.x0 + m) tx += fw.x0 + m - sx; else if (sx > fw.x1 - m) tx -= sx - (fw.x1 - m);
      if (sy < fw.y0 + m) ty += fw.y0 + m - sy; else if (sy > fw.y1 - m) ty -= sy - (fw.y1 - m);
    }
    else {
      const iconW = Math.max(E.iconWidth(slug), 160);
      z = clamp(120 / (iconW * geo.k), 1.6, 3.0); tx = fc.x - z * a.x; ty = fc.y - z * a.y;
    }
    setCam(z, tx, ty, ms == null ? 900 : ms, 'var(--ease-cam)', win);
  }
  // После смены окна (панель закрылась) камера возвращается в допустимое положение
  function settleCam(ms) {
    const c = clampCam(cam.z, cam.tx, cam.ty);
    if (Math.abs(c.tx - cam.tx) > .5 || Math.abs(c.ty - cam.ty) > .5 || c.z !== cam.z) { cam.z = c.z; cam.tx = c.tx; cam.ty = c.ty; applyCam(ms); }
  }
  function syncButtons() {
    if (!els.zoomIn) return;
    const c = centerOf(geo.V), p = geo.paper, zf = minZ(), atFit = cam.z <= zf + 1e-4 && Math.abs(cam.tx - (c.x - p.w * cam.z / 2)) < 1 && Math.abs(cam.ty - (c.y - p.h * cam.z / 2)) < 1;
    const set = (b, off) => { if (b.disabled !== off) { const had = D.activeElement === b; b.disabled = off; if (had && off) { const alt = off && b === els.zoomIn ? els.zoomOut : els.zoomIn; if (alt && !alt.disabled) alt.focus({ preventScroll: true }); } } };
    set(els.zoomIn, cam.z >= MAX_Z - 1e-4); set(els.zoomOut, cam.z <= zf + 1e-4); set(els.fit, atFit);
  }

  /* ---------------- места: данные, якоря, поиск под точкой ---------------- */
  function resolveSlug(raw) {
    if (!raw) return null; const s = String(raw).toLowerCase();
    if (BY.has(s)) return s; return ALIAS.get(s) || null;
  }
  function iconRect(slug) { const e = E.placeEls.get(slug); return e && e.icon ? e.icon.getBoundingClientRect() : null; }
  function anchorClient(slug) { const r = iconRect(slug); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }
  // Место под точкой: среди мест, чьи зоны накрывают точку, берётся ближайшее по якорю; иначе ближайший якорь в радиусе 28 px.
  // (Зоны соседей перекрываются, поэтому по elementFromPoint решение не принимается.)
  function placeAt(x, y) {
    let best = null, bd = Infinity, near = null, nd = 28;
    for (const [slug, e] of E.placeEls) {
      const a = anchorClient(slug); if (!a) continue;
      let d = Math.hypot(a.x - x, a.y - y);
      // Подпись тоже якорь (QA v2 B1): нажатие в центр надписи ближе всего к своему месту, даже когда зоны соседей накрывают точку
      // (корабль и надпись моря на минимальном масштабе стоят рядом, а корабль ходит по кругу)
      const lr = e.label && e.label.getBoundingClientRect(); if (lr && lr.width) d = Math.min(d, Math.hypot(lr.left + lr.width / 2 - x, lr.top + lr.height / 2 - y));
      // зон две у корабля: сам корабль и его подпись (QA v2 B1); у остальных мест одна
      const inside = [e.hit, e.hit2].some(z => { const r = z && z.getBoundingClientRect(); return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
      if (inside && d < bd) { bd = d; best = slug; }
      if (d < nd) { nd = d; near = slug; }
    }
    return best || near;
  }

  /* ---------------- подсказка над местом (ТЗ 3.7) ---------------- */
  const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
  // hoverSlug обнуляется при любом скрытии: после колеса, нажатия или перетаскивания подсказка снова включится от следующего движения
  function hideTip() {
    clearTimeout(tipTimer); tipSlug = null; hoverSlug = null;
    if (els.tip) els.tip.classList.remove('on');
  }
  // Стилевой проход: подсказка встаёт над иконкой вместе с её подписью на карте, а не закрывает подпись.
  // По горизонтали она по-прежнему по центру иконки; если подпись сбоку или снизу, положение не меняется.
  function tipRect(slug) {
    const e = E.placeEls.get(slug), r = iconRect(slug); if (!r) return null;
    const l = e && e.label ? e.label.getBoundingClientRect() : null;
    if (!l || !l.width) return r;
    return { left: r.left, width: r.width, top: Math.min(r.top, l.top), bottom: Math.max(r.bottom, l.bottom) };
  }
  function showTip(slug) {
    const p = BY.get(slug), r = tipRect(slug); if (!p || !r || !els.tip) return;
    tipSlug = slug;
    els.tip.replaceChildren(h('span', { class: 'tip__name', text: p.name }), h('span', { class: 'tip__type', text: p.type }));
    els.tip.style.transform = 'translate(0,0)'; els.tip.classList.add('on');
    const tw = els.tip.offsetWidth, th = els.tip.offsetHeight, vw = D.documentElement.clientWidth;
    let x = r.left + r.width / 2 - tw / 2, y = r.top - 8 - th;
    if (y < 8) y = r.bottom + 8;
    x = clamp(x, 8, vw - 8 - tw);
    els.tip.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
  let hoverG = null;
  function setHover(slug) {
    if (slug && slug === hoverSlug) return;
    if (hoverG) { hoverG.classList.remove('place--hover'); hoverG = null; }
    hideTip(); hoverSlug = slug;
    E.els.vp.style.cursor = slug ? 'pointer' : '';
    if (!slug) return;
    const e = E.placeEls.get(slug); if (!e) return;
    hoverG = e.g; e.g.classList.add('place--hover');
    if (slug !== S.place || S.view !== 'place') tipTimer = setTimeout(() => showTip(slug), 300);
  }

  /* ---------------- ввод: указатель, колесо, клавиши (ТЗ 3.1, 3.8) ---------------- */
  const ptr = new Map(); let gest = null; const skipped = new Set(); let swallowClick = 0;
  function startDrag() {
    gest.mode = 'drag'; setHover(null);   // подсветка места и курсор pointer уходят: на время жеста работает grabbing
    try { E.els.vp.setPointerCapture(gest.id); } catch (e) {}
    E.els.vp.classList.add('drag');
  }
  function endGesture() { E.els.vp.classList.remove('drag'); gest = null; }
  function beginPinch() {
    const [a, b] = [...ptr.entries()]; setHover(null);
    const d0 = Math.max(Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y), 1), mid0 = { x: (a[1].x + b[1].x) / 2, y: (a[1].y + b[1].y) / 2 };
    const p = geo.paper;
    gest = { mode: 'pinch', ids: [a[0], b[0]], d0, z0: cam.z, mid0,
      u0: { x: (mid0.x - p.left - cam.tx) / cam.z, y: (mid0.y - p.top - cam.ty) / cam.z } };
    [a[0], b[0]].forEach(id => { try { E.els.vp.setPointerCapture(id); } catch (e) {} });
    E.els.vp.classList.add('drag');
  }
  function pinchMove() {
    const [a, b] = gest.ids.map(id => ptr.get(id)); if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, p = geo.paper;
    const z = clamp(gest.z0 * d / gest.d0, minZ(), MAX_Z);
    setCam(z, mx - p.left - z * gest.u0.x, my - p.top - z * gest.u0.y, 0);
  }
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (skipped.has(e.pointerId) || E.state !== 'ready') return;
    interrupt(); hideTip(); hideCoach();
    ptr.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (ptr.size === 1) gest = { mode: 'pending', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, tx0: cam.tx, ty0: cam.ty, type: e.pointerType };
    else if (ptr.size === 2) beginPinch();
  }
  function onMove(e) {
    const p = ptr.get(e.pointerId);
    if (!p) { if (e.pointerType === 'mouse' && !e.buttons && E.state === 'ready' && finePointer()) hoverAt(e.clientX, e.clientY); return; }
    p.x = e.clientX; p.y = e.clientY;
    if (!gest) return;
    if (gest.mode === 'pending' && e.pointerId === gest.id && Math.hypot(p.x - gest.x0, p.y - gest.y0) > (gest.type === 'mouse' ? 6 : 10)) startDrag();
    if (gest.mode === 'drag' && e.pointerId === gest.id) setCam(cam.z, gest.tx0 + p.x - gest.x0, gest.ty0 + p.y - gest.y0, 0);
    else if (gest.mode === 'pinch') pinchMove();
  }
  function onUp(e) {
    if (skipped.delete(e.pointerId)) { ptr.delete(e.pointerId); return; }
    const had = ptr.delete(e.pointerId); if (!had || !gest) return;
    if (gest.mode === 'pending' && e.pointerId === gest.id) {
      const tap = e.type === 'pointerup' && e.timeStamp - gest.t0 < 600;
      const type = gest.type; gest = null;
      if (tap) onTap(e.clientX, e.clientY, type);
    } else if (gest.mode === 'drag' && e.pointerId === gest.id) endGesture();
    else if (gest.mode === 'pinch') {
      if (ptr.size === 1) {   // остался один палец: перетаскивание от нового положения, без скачка
        const [id, q] = [...ptr.entries()][0];
        gest = { mode: 'drag', id, x0: q.x, y0: q.y, tx0: cam.tx, ty0: cam.ty, type: q.type };
      } else endGesture();
    }
  }
  function onTap(x, y, type) {
    const slug = placeAt(x, y);
    if (slug) { lastTap = null; openPlace(slug, { source: 'map' }); return; }
    // двойной тап по пустой карте: приблизить в 1,6 раза (P2)
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) { lastTap = null; zoomAt(x, y, 1.6, 220); return; }
    lastTap = { t: now, x, y };
    if (S.place != null && S.view === 'place') closeCard({ source: 'map' });
  }
  // Поиск места под курсором: первое движение сразу, следующие не чаще раза в 30 мс (таймером, а не кадром: от кадров подсказка не зависит)
  let hoverLast = 0, hoverTimer = 0, hoverPt = null;
  function runHover() { hoverLast = performance.now(); if (hoverPt && E.state === 'ready' && !gest) setHover(placeAt(hoverPt.x, hoverPt.y)); }
  function hoverAt(x, y) {
    hoverPt = { x, y };
    const wait = 30 - (performance.now() - hoverLast);
    if (wait <= 0) runHover();
    else if (!hoverTimer) hoverTimer = setTimeout(() => { hoverTimer = 0; runHover(); }, wait);
  }
  function onWheel(e) {
    e.preventDefault();
    if (e.__dcmSkip || E.state !== 'ready') return;
    interrupt(); hideTip(); hideCoach();
    let dy = e.deltaY; if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= geo.vh;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), 0);
  }
  function onKey(e) {
    if (E.state !== 'ready' || e.altKey || e.ctrlKey || e.metaKey) return;
    const f = freeWin(), fw = f.x1 - f.x0, fh = f.y1 - f.y0, step = e.shiftKey ? .4 : .15;
    const onPlace = e.target.closest && e.target.closest('g.place');
    switch (e.key) {
      case 'ArrowRight': panBy(-fw * step, 0, 120); break;
      case 'ArrowLeft': panBy(fw * step, 0, 120); break;
      case 'ArrowDown': panBy(0, -fh * step, 120); break;
      case 'ArrowUp': panBy(0, fh * step, 120); break;
      case '+': case '=': zoomStep(1.5); break;
      case '-': case '_': zoomStep(1 / 1.5); break;
      case '0': interrupt(); fitCam(220); break;
      case 'Enter': case ' ':
        if (!onPlace) return;
        openPlace(onPlace.dataset.slug, { source: 'kbd', kbd: true, opener: onPlace }); break;
      default: return;
    }
    e.preventDefault();
  }

  /* ---------------- вступление: пропуск (ТЗ 3.9) ---------------- */
  function installSkip() {
    const isMod = e => e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key);
    ['pointerdown', 'keydown', 'wheel'].forEach(type => D.addEventListener(type, e => {
      if (E.state !== 'intro' || isMod(e)) return;
      if (E.skipIntro()) {
        e.__dcmSkip = true;
        if (type === 'pointerdown') { skipped.add(e.pointerId); swallowClick = performance.now() + 700; }
        if (type === 'keydown' && e.key !== 'Tab') e.stopImmediatePropagation();
      }
    }, { capture: true, passive: true }));
    // клик, которым закончился пропуск, больше ничего не делает
    D.addEventListener('click', e => { if (swallowClick && performance.now() < swallowClick) { swallowClick = 0; e.stopPropagation(); e.preventDefault(); } }, true);
  }

  /* ---------------- карточка и указатель ---------------- */
  // ТЗ 4.3: одна функция для всех ссылок наружу, UTM выключены флагом. medium: card (карточка), head (логотип), index (полоса и подвал указателя)
  function outboundUrl(url, place, medium) {
    if (!UTM) return url;
    const u = new URL(url);
    u.searchParams.set('utm_source', 'dragon-coast-map'); u.searchParams.set('utm_medium', medium || 'card');
    if (place) u.searchParams.set('utm_content', place);
    return u.toString();
  }
  function wikiHref(p) {
    let u = META.wikiBase + p.wiki.path;
    if (p.wiki.textFragment) u += '#:~:text=' + encodeURIComponent(p.wiki.textFragment);
    return u;
  }
  function extLink(href, text, cls, id, place) {
    const a = h('a', { href: outboundUrl(href, place, 'card'), target: '_blank', rel: 'noopener', 'aria-label': text + ', ' + t('card.newTab'), class: cls, id });
    a.append(text, ext()); return a;
  }
  function renderCard(slug) {
    const p = BY.get(slug), card = els.card;
    const kids = [];
    kids.push(h('div', { class: 'card__bar' }, [
      S.fromIndex ? h('button', { type: 'button', class: 'btn-text', 'data-action': 'back' }, [h('span', { html: svg('back', 18), class: 'btn-icon' }), t('card.back')]) : h('span', { class: 'card__bar-gap' }),
      h('button', { type: 'button', class: 'btn-text', 'data-action': 'close', text: t('card.close') }),
    ]));
    kids.push(h('h2', { id: 'card-title', tabindex: '-1', text: p.name }));
    kids.push(h('p', { id: 'card-type', text: p.type }));
    // Строка статуса выводится, только если для статуса места есть строка в strings.json (решения заказчика 2026-10-20: у мест без статьи в вики,
    // status master, и у трёх городов с абзацем в статье «Драконье Море», status section, статуса нет; остались article и show)
    const statusText = t('card.status.' + p.status);
    if (statusText) kids.push(h('p', { id: 'card-status' }, [h('span', { class: 'diamond', 'aria-hidden': 'true' }), h('span', { text: statusText })]));
    if (p.ruler) kids.push(h('p', { id: 'card-ruler', text: t('card.ruler', { ruler: p.ruler }) }));
    kids.push(h('div', { id: 'card-text' }, (p.text || []).map(x => h('p', { text: x }))));
    if (p.wiki) kids.push(extLink(wikiHref(p), t('card.readWiki'), 'pill', 'card-wiki', slug));
    else if (p.kind === 'ship' && (p.link || META.youtube)) kids.push(extLink(p.link || META.youtube, t('card.showLink'), 'pill', 'card-show', slug));
    if (p.related && p.related.length) kids.push(h('section', { id: 'card-related' }, [
      h('h3', { text: t('card.related') }),
      h('ul', null, p.related.map(r => h('li', null, [h('a', { href: outboundUrl(META.wikiBase + r.path, slug, 'card'), target: '_blank', rel: 'noopener', 'aria-label': r.title + ', ' + t('card.newTab') }, [r.title, ext()])]))),
    ]));
    kids.push(h('button', { type: 'button', class: 'btn-text btn-share', 'data-action': 'share', 'aria-live': 'polite' }, [h('span', { html: svg('link', 16), class: 'btn-icon' }), h('span', { class: 'btn-share__label', text: t('card.share') })]));
    kids.push(h('div', { class: 'card__copyfail', hidden: true }, [
      h('label', { for: 'card-url', text: t('card.copyFailed') }), h('input', { id: 'card-url', type: 'text', readonly: true, value: '', tabindex: '-1' }),
    ]));
    card.replaceChildren(...kids);
    card.dataset.status = p.status; card.dataset.slug = slug; card.scrollTop = 0;
  }
  function renderIndex() {
    // группы по местности (поле group), порядок как в TEXTS.md раздел 5; в группе сначала море, потом острова и города по алфавиту, потом корабль
    const rank = p => p.kind === 'sea' ? 0 : p.kind === 'ship' ? 2 : 1, sortIdx = (a, b) => (rank(a) - rank(b)) || sortRu(a, b);
    const idx = els.index, groups = [['places.groupNorth', 'north'], ['places.groupMountains', 'mountains'], ['places.groupSea', 'sea']]
      .map(([key, g]) => [key, LIST.filter(p => p.group === g)]);
    const kids = [h('h2', { id: 'index-title', tabindex: '-1', text: t('places.title') }), h('p', { class: 'index-lead', text: t('places.lead') })];
    groups.forEach(([key, arr]) => { if (!arr.length) return;
      kids.push(h('div', { class: 'index-group' }, [h('h3', { text: t(key) }), h('ul', null, arr.slice().sort(sortIdx).map(p =>
        h('li', null, [h('button', { type: 'button', class: 'index-item', 'data-slug': p.slug }, [h('span', { class: 'index-item__name', text: p.name }), h('span', { class: 'index-item__type', text: p.type })])])))])); });
    kids.push(h('footer', { class: 'index-foot' }, [
      h('button', { type: 'button', class: 'btn-text', 'data-action': 'replay', text: t('places.replay'), hidden: reduced }),
      h('a', { class: 'link-quiet link-wiki', href: outboundUrl(META.wikiBase + '/', null, 'index'), target: '_blank', rel: 'noopener', 'aria-label': t('links.wikiAria') }, [t('links.wiki'), ext()]),
      h('a', { class: 'link-quiet link-show', href: outboundUrl(META.taplink, null, 'index'), target: '_blank', rel: 'noopener', 'aria-label': t('links.showAria') }, [t('links.show'), ext()]),
    ]));
    idx.replaceChildren(...kids);
  }

  /* ---------------- панель и лист (ТЗ 5.5, 3.3) ---------------- */
  function readSheetVis() {
    if (!sheetMode()) return sheetVis;
    const p = els.panel, m = new DOMMatrix(getComputedStyle(p).transform);
    return Math.max(0, p.offsetHeight - m.f);
  }
  function measureOpen() {
    const p = els.panel, was = [p.style.height, p.style.transform, p.style.transition, p.dataset.view];
    p.style.transition = 'none'; p.style.transform = 'none'; p.style.height = 'auto'; p.dataset.view = 'place';
    els.card.style.maxHeight = 'none';
    openH = p.offsetHeight; els.card.style.maxHeight = '';
    [p.style.height, p.style.transform, p.style.transition, p.dataset.view] = was;
    return openH;
  }
  // Смена состояния листа сдвигом transform: 280 мс вверх, 210 мс вниз; высота коробки в покое равна высоте состояния
  function sheetTo(state, animate) {
    const p = els.panel, to = sheetHeight(state), from = animate ? readSheetVis() : to;
    clearTimeout(sheetTimer);
    sheetVis = to;
    if (!animate || reduced || from === to) {
      p.style.transition = 'none'; p.style.height = (to || (from || 1)) + 'px'; p.style.transform = to ? 'none' : `translateY(${from || 1}px)`;
      p.dataset.hidden = to ? 'false' : 'true'; return;
    }
    const box = Math.max(from, to), up = to > from;
    p.dataset.hidden = 'false';
    p.style.transition = 'none'; p.style.height = box + 'px'; p.style.transform = `translateY(${box - from}px)`;
    void p.offsetHeight;
    p.style.transition = `transform ${up ? 280 : 210}ms var(${up ? '--ease-out' : '--ease-in'})`;
    p.style.transform = `translateY(${box - to}px)`;
    sheetTimer = setTimeout(() => {
      p.style.transition = 'none'; p.style.height = (to || box) + 'px';
      p.style.transform = to ? 'none' : `translateY(${box}px)`; if (!to) p.dataset.hidden = 'true';
    }, (up ? 280 : 210) + 40);
  }
  function setPanel(state, view, animate) {
    const p = els.panel;
    S.state = state; if (view) S.view = view;
    p.dataset.state = state; p.dataset.view = S.view;
    D.body.classList.toggle('sheet-up', sheetMode() && (state === 'half' || state === 'open'));
    if (state === 'half' || state === 'open') hideCoach();
    $$('[data-action=open-index]').forEach(b => b.setAttribute('aria-expanded', String(state === 'half' && S.view === 'index')));
    if (sheetMode()) sheetTo(state, animate);
    else {
      clearTimeout(sheetTimer); p.style.height = ''; p.style.transform = ''; p.style.transition = '';
      if (state === 'closed') { sidePanelHide(); } else { p.dataset.hidden = 'false'; }
    }
  }
  let hideTimer = 0;
  function sidePanelHide() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (S.state === 'closed') els.panel.dataset.hidden = 'true'; }, reduced ? 160 : 230); }
  const restState = () => sheetMode() ? 'peek' : 'closed';

  function openIndex(o) {
    o = o || {};
    if (S.place != null) { closeCard({ toIndex: true, source: 'back', focusIndex: !!o.focus }); return; }
    renderIndexVisible();
    setPanel('half', 'index', true); settleCam(280);
    if (o.focus) setTimeout(() => $('#index-title').focus({ preventScroll: true }), 30);
  }
  function renderIndexVisible() { els.panel.dataset.view = 'index'; S.view = 'index'; }
  function toggleIndex() {
    if (S.state === 'half' && S.view === 'index') { setPanel(restState(), 'index', true); settleCam(260); }
    else openIndex();
  }
  function openPlace(slug, o) {
    o = o || {}; const p = BY.get(slug); if (!p || !dataOk) return false;
    hideTip(); hideCoach();
    const wasCard = S.place != null && S.view === 'place';
    // «← Все места» есть только у карточки, открытой из указателя; при переключении между местами остаётся как было
    if (o.source === 'index') S.fromIndex = true; else if (!wasCard) S.fromIndex = false;
    S.kbd = !!o.kbd; S.opener = o.kbd ? (o.opener || D.activeElement) : null;
    // адрес и история: из закрытого состояния pushState, между местами replaceState
    if (o.history !== 'none') {
      const url = mapUrl(slug);
      if (!wasCard) { try { history.pushState({ dcm: 1, place: slug }, '', url); S.pushed = true; } catch (e) {} }
      else { try { history.replaceState({ dcm: 1, place: slug }, '', url); } catch (e) {} }
    } else if (o.pushed != null) S.pushed = o.pushed;
    const apply = () => {
      S.place = slug; S.cardSlug = slug;
      renderCard(slug); els.panel.dataset.view = 'place'; S.view = 'place';
      measureOpen();
      setPanel('open', 'place', true);
      flyTo(slug, 'open', reduced ? 0 : 900);
      if (S.kbd) { const tt = $('#card-title'); if (tt) tt.focus({ preventScroll: true }); }
    };
    if (wasCard && !reduced) {   // перекрёстное затухание 150 мс
      els.card.classList.add('is-swapping'); setTimeout(() => { apply(); els.card.classList.remove('is-swapping'); }, 75);
    } else apply();
    return true;
  }
  function doCloseUI(o) {
    o = o || {};
    const toIndex = o.toIndex || (S.fromIndex && o.source !== 'map' && o.source !== 'esc' && o.source !== 'close');
    S.place = null; S.cardSlug = null; S.fromIndex = false;
    hideTip();
    if (toIndex) { renderIndexVisible(); setPanel('half', 'index', true); }
    else setPanel(restState(), 'index', true);
    settleCam(280);
    const op = S.opener; S.opener = null;
    if (o.focusIndex) { const ti = $('#index-title'); if (ti) ti.focus({ preventScroll: true }); }
    else if (S.kbd && op && op.isConnected) op.focus({ preventScroll: true });
    S.kbd = false;
  }
  function closeCard(o) {
    o = o || {};
    if (S.place == null) return;
    if (o.fromPop) { doCloseUI(o); return; }
    if (S.pushed && history.state && history.state.dcm) { S.pushed = false; S.closeOpts = o; history.back(); return; }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    doCloseUI(o);
  }
  function closePanel(o) {   // Esc, «Закрыть», __map.close()
    o = o || {};
    if (S.place != null) closeCard(o);
    else if (S.state === 'half' || S.state === 'open') { setPanel(restState(), 'index', true); settleCam(260); }
  }
  const mapUrl = slug => location.origin + location.pathname + (slug ? '?place=' + encodeURIComponent(slug) : '');
  function onPop() {
    const q = new URLSearchParams(location.search).get('place'), slug = resolveSlug(q);
    if (slug) { S.pushed = !!(history.state && history.state.dcm); if (S.place !== slug || S.view !== 'place') openPlace(slug, { history: 'none', pushed: S.pushed, source: 'url' }); }
    else if (S.place != null) { const o = S.closeOpts || {}; S.closeOpts = null; doCloseUI({ ...o, fromPop: true, source: o.source || 'popstate' }); }
  }

  /* ---------------- «Поделиться» (ТЗ 3.5) ---------------- */
  let shareTimer = 0;
  async function share() {
    const p = BY.get(S.place); if (!p) return;
    const url = mapUrl(p.slug), btn = $('[data-action=share]', els.card), label = $('.btn-share__label', btn);
    if (navigator.share && coarse) {
      try { await navigator.share({ title: p.name, text: t('card.shareText', { shareName: p.shareName || p.name }), url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch (e) {}
    if (!ok) { try { const ta = h('textarea', { 'aria-hidden': 'true' }); ta.style.cssText = 'position:fixed;opacity:0'; ta.value = url; D.body.append(ta); ta.select(); ok = D.execCommand && D.execCommand('copy'); ta.remove(); } catch (e) { ok = false; } }
    if (ok) {
      const text = t('card.copied'); label.textContent = text; clearTimeout(shareTimer);
      shareTimer = setTimeout(() => { const l = $('.btn-share__label', els.card); if (l) l.textContent = t('card.share'); }, 2000);
    } else {
      const box = $('.card__copyfail', els.card), inp = $('#card-url', els.card); box.hidden = false; inp.tabIndex = 0; inp.value = url; inp.focus(); inp.select();
    }
  }

  /* ---------------- сообщения и подсказка первого визита ---------------- */
  let toastTimer = 0;
  function toast(key, opts) {
    opts = opts || {};
    if (!chromeOn && !opts.now) { pendingToasts.push([key, opts]); return; }
    const n = els.toast; if (!n) return;
    n.textContent = t(key); n.classList.toggle('is-error', !!opts.error); n.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => n.classList.remove('on'), opts.ms || 4000);
  }
  let coachTimer = 0;
  function showCoach(key) {
    if (!els.coach) return;
    clearTimeout(coachTimer); els.coach.textContent = t(key); els.coach.classList.add('on');
    coachTimer = setTimeout(hideCoach, 6000);
  }
  function hideCoach() { clearTimeout(coachTimer); if (els.coach) els.coach.classList.remove('on'); }

  /* ---------------- сборка интерфейса ---------------- */
  function btnIcon(action, name, label) {
    return h('button', { type: 'button', class: 'btn-icon-ctl', 'data-action': action, 'aria-label': label, title: label, html: svg(name) });
  }
  function buildControls() {
    const nav = h('nav', { class: 'controls', 'aria-label': t('controls.aria') });
    els.zoomIn = btnIcon('zoom-in', 'plus', t('controls.zoomIn'));
    els.zoomOut = btnIcon('zoom-out', 'minus', t('controls.zoomOut'));
    els.fit = btnIcon('fit', 'fit', t('controls.fit'));
    els.motion = btnIcon('motion', 'pause', t('controls.pause'));
    nav.append(els.zoomIn, els.zoomOut, els.fit, els.motion);
    els.controls = nav; return nav;
  }
  function syncMotionButton() {
    const on = E.motion, b = els.motion; if (!b) return;
    const label = on ? t('controls.pause') : t('controls.play');
    b.setAttribute('aria-label', label); b.title = label; b.innerHTML = svg(on ? 'pause' : 'wave');
  }
  function buildChrome() {
    const stage = $('.stage-wrap');
    // ссылка «К списку мест»: первая на странице, видна только в фокусе
    els.skip = h('a', { class: 'skip-link', href: '#index', text: t('a11y.skip') });
    D.body.prepend(els.skip);
    els.head = h('header', { class: 'app-head' }, [
      h('a', { class: 'app-logo', href: outboundUrl(META.taplink, null, 'head'), target: '_blank', rel: 'noopener', 'aria-label': t('head.logoAria') }, [h('img', { src: 'brand/strazhi_gold.' + E.EXT(), alt: t('head.logoAlt'), draggable: 'false' })]),
      h('h1', { class: 'app-title', text: t('head.title') }), h('p', { class: 'app-sub', text: t('head.sub') }),
    ]);
    D.body.insertBefore(els.head, stage);
    els.places = h('button', { type: 'button', class: 'btn-places', 'data-action': 'open-index' }, [t('places.button'), h('span', { class: 'count', text: String(LIST.length) })]);
    els.band = h('div', { class: 'band' }, [
      els.places,
      h('a', { id: 'link-wiki', class: 'link-quiet', href: outboundUrl(META.wikiBase + '/', null, 'index'), target: '_blank', rel: 'noopener', 'aria-label': t('links.wikiAria') }, [t('links.wiki'), ext()]),
      h('a', { id: 'link-show', class: 'link-quiet', href: outboundUrl(META.taplink, null, 'index'), target: '_blank', rel: 'noopener', 'aria-label': t('links.showAria') }, [t('links.show'), ext()]),
    ]);
    els.rail = h('div', { class: 'rail' });
    buildControls();
    els.panel = h('aside', { id: 'panel', 'data-view': 'index', 'data-state': 'closed', 'data-hidden': 'true', 'aria-label': t('places.title') }, [
      h('div', { class: 'panel__handle' }, [h('span', { class: 'panel__grab', 'aria-hidden': 'true' }),
        h('button', { type: 'button', 'data-action': 'open-index', class: 'peek' }, [h('span', { class: 'peek__label', text: t('places.button') }), h('span', { class: 'count', text: String(LIST.length) }), h('span', { class: 'peek__chev', html: svg('chevron') })])]),
      els.index = h('section', { id: 'index', 'aria-labelledby': 'index-title' }),
      els.card = h('article', { id: 'card', 'aria-labelledby': 'card-title' }),
    ]);
    D.body.append(els.band, els.rail, els.panel);
    renderIndex(); placeControls(); syncMotionButton(); syncButtons();
    // карта для клавиатуры и скринридера
    const vp = E.els.vp;
    E.els.ov.setAttribute('tabindex', '-1');   // корень SVG сам по себе попадает в порядок табуляции как прокручиваемый блок
    vp.tabIndex = 0; vp.setAttribute('role', 'region'); vp.setAttribute('aria-roledescription', t('map.roledesc')); vp.setAttribute('aria-label', t('map.aria'));
    installPanelDrag();
  }
  function placeControls() {
    const host = layout === 'wide' ? els.band : els.rail;
    if (els.controls.parentNode !== host) host.append(els.controls);
    // «Все места»: в нижней полосе (wide) или справа от названия в плашке (landscape, QA v2 B3); на телефоне и планшете вход даёт ярлык листа
    const ph = layout === 'landscape' ? els.head : els.band;
    if (els.places.parentNode !== ph) { if (ph === els.head) ph.append(els.places); else ph.prepend(els.places); }
  }

  /* ---------------- места на карте: роли, имена, порядок табуляции ---------------- */
  function bindPlaces() {
    const arr = [...E.placeEls.entries()].map(([slug, e]) => ({ slug, e, x: (E.anchor(slug) || { x: 0 }).x }));
    arr.sort((a, b) => a.x - b.x);
    arr.forEach(({ slug, e }) => {
      const p = BY.get(slug); if (!p) return;
      e.g.setAttribute('role', 'button'); e.g.setAttribute('tabindex', '0'); e.g.setAttribute('aria-label', p.name + ', ' + p.type);
      E.els.ov.append(e.g);    // порядок в DOM = порядок табуляции с запада на восток
    });
    sizeHits();
    // клавиатура и фокус: подсказка сразу, карта подъезжает к месту, не меняя масштаб
    E.els.ov.addEventListener('focusin', e => {
      const g = e.target.closest && e.target.closest('g.place'); if (!g) return;
      if (!g.matches(':focus-visible')) return;
      ensureVisible(g.dataset.slug); showTip(g.dataset.slug);
    });
    E.els.ov.addEventListener('focusout', () => hideTip());
  }
  function ensureVisible(slug) {
    const a = anchorPaper(slug); if (!a) return;
    interrupt();
    const w = freeWin(), z = cam.z, sx = a.x * z + cam.tx, sy = a.y * z + cam.ty, m = 40;
    let dx = 0, dy = 0;
    if (sx < w.x0 + m) dx = w.x0 + m - sx; else if (sx > w.x1 - m) dx = w.x1 - m - sx;
    if (sy < w.y0 + m) dy = w.y0 + m - sy; else if (sy > w.y1 - m) dy = w.y1 - m - sy;
    if (dx || dy) setCam(z, cam.tx + dx, cam.ty + dy, 200);
  }

  /* ---------------- нижний лист: перетаскивание за ручку ---------------- */
  function installPanelDrag() {
    const p = els.panel; let d = null;
    p.addEventListener('pointerdown', e => {
      if (!sheetMode() || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (!e.target.closest('.panel__handle, .card__bar')) return;
      d = { id: e.pointerId, y0: e.clientY, vis: readSheetVis(), moved: false, hist: [], t0: e.timeStamp, x0: e.clientX };
    });
    p.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y0;
      if (!d.moved && Math.abs(dy) > (e.pointerType === 'mouse' ? 6 : 10)) {
        d.moved = true; try { p.setPointerCapture(e.pointerId); } catch (x) {}
        d.max = Math.max(sheetHeight('open'), sheetHeight('half'), d.vis); d.min = sheetHeight('peek');
        clearTimeout(sheetTimer); p.style.transition = 'none'; p.style.height = d.max + 'px';
      }
      if (!d.moved) return;
      const vis = clamp(d.vis - dy, d.min, d.max);
      p.style.transform = `translateY(${d.max - vis}px)`; d.cur = vis;
      d.hist.push([e.timeStamp, e.clientY]); if (d.hist.length > 6) d.hist.shift();
    });
    const end = e => {
      if (!d || e.pointerId !== d.id) return;
      const dd = d; d = null;
      if (!dd.moved) return;
      swallowClick = 0; p.dataset.dragged = '1'; setTimeout(() => delete p.dataset.dragged, 60);
      const hs = dd.hist, v = hs.length > 1 ? (hs[hs.length - 1][1] - hs[0][1]) / Math.max(hs[hs.length - 1][0] - hs[0][0], 1) : 0;   // px/мс, вниз положительно
      const cur = dd.cur != null ? dd.cur : dd.vis;
      const states = S.view === 'place' ? ['__dismiss', 'open'] : ['peek', 'half'];
      const H = states.map(s => s === '__dismiss' ? sheetHeight(S.fromIndex ? 'half' : 'peek') : sheetHeight(s));
      let i = H.reduce((b, x, k) => Math.abs(x - cur) < Math.abs(H[b] - cur) ? k : b, 0);
      if (Math.abs(v) > .5 && e.type === 'pointerup') i = v < 0 ? states.length - 1 : 0;   // скорость больше 0,5 px/мс: в сторону жеста
      const target = states[i];
      p.style.height = Math.max(dd.max, 1) + 'px'; sheetVis = cur;
      if (target === '__dismiss') { sheetVis = cur; closeCard({ source: 'swipe' }); }
      else if (target === S.state) sheetTo(target, true);
      else { setPanel(target, S.view, true); settleCam(260); }
    };
    p.addEventListener('pointerup', end); p.addEventListener('pointercancel', end);
    p.addEventListener('click', e => { if (p.dataset.dragged) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  /* ---------------- действия ---------------- */
  function onClick(e) {
    const b = e.target.closest('[data-action]'), idxItem = e.target.closest('.index-item');
    if (idxItem) { openPlace(idxItem.dataset.slug, { source: 'index', kbd: e.detail === 0, opener: idxItem }); return; }
    if (!b) return;
    switch (b.dataset.action) {
      case 'open-index': if (sheetMode()) { if (S.state === 'peek' || S.state === 'closed') openIndex(); else if (S.state === 'half') { setPanel('peek', 'index', true); settleCam(260); } } else toggleIndex(); break;
      case 'back': S.kbd = e.detail === 0; closeCard({ toIndex: true, source: 'back' }); break;
      case 'close': closeCard({ source: 'close' }); break;
      case 'share': share(); break;
      case 'replay': doReplay(); break;
      case 'zoom-in': zoomStep(1.5); break;
      case 'zoom-out': zoomStep(1 / 1.5); break;
      case 'fit': interrupt(); fitCam(220); break;
      case 'motion': { const on = !E.motion; E.setMotion(on); store.set('localStorage', 'dcm:motion', on ? 'on' : 'off'); syncMotionButton(); break; }
    }
  }
  function doReplay() {
    S.place = null; S.fromIndex = false; S.kbd = false;
    if (history.state && history.state.dcm) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
    setPanel(restState(), 'index', false);
    startCam();
    E.replay();
  }

  /* ---------------- вход: фазы вступления, данные, раскладка ---------------- */
  function motionPref() {
    const v = store.get('localStorage', 'dcm:motion');
    if (v === 'on') return true; if (v === 'off') return false;
    return !reduced;
  }
  let geoKey = '';
  function relayout(force) {
    const key = [W.innerWidth, W.innerHeight, JSON.stringify(readSafe())].join('|');
    if (!force && key === geoKey) return;   // щипок страницы и прыжки панелей браузера, не менявшие размеры, перестройки не требуют
    geoKey = key;
    const f = geo ? centerOf(freeWin()) : null;
    // точка листа в центре свободной области до перестройки (в долях листа)
    const u = geo ? { x: (f.x - cam.tx) / cam.z / geo.paper.w, y: (f.y - cam.ty) / cam.z / geo.paper.h } : null;
    const prev = layout, prevK = lblK; geo = computeGeo(); layout = geo.layout; applyGeo(geo);
    if (lblK !== prevK && E.relabel) E.relabel();   // кегль подписей сменился: раскладка подписей без наложений заново, зоны нажатия ниже подгоняет sizeHits
    if (els.controls) placeControls();
    if (els.panel) {
      if (prev !== layout) { if (S.state === 'closed' && sheetMode() && chromeOn) S.state = 'peek'; if (S.state === 'peek' && sidePanel()) S.state = 'closed'; if (sidePanel() && S.state === 'half' && S.view !== 'index') S.view = 'index'; }
      if (S.state === 'open' || S.place != null) measureOpen();
      setPanel(S.state, S.view, false);
    }
    if (u) { const f2 = centerOf(freeWin()); setCam(cam.z, f2.x - cam.z * u.x * geo.paper.w, f2.y - cam.z * u.y * geo.paper.h, 0); }
    else startCam();
    // открытое место не должно оказаться под панелью после поворота: тогда камера возвращается к нему
    if (S.place != null && S.view === 'place' && E.anchor(S.place)) {
      const a = anchorPaper(S.place), f = freeWin(), sx = a.x * cam.z + cam.tx, sy = a.y * cam.z + cam.ty;
      if (sx < f.x0 || sx > f.x1 || sy < f.y0 || sy > f.y1) flyTo(S.place, S.state, 0);
    }
    sizeHits();
    D.body.classList.toggle('sheet-up', sheetMode() && (S.state === 'half' || S.state === 'open'));
    E.resize();
  }
  let resizeRaf = 0;
  function onResize() { if (resizeRaf) return; resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; relayout(); }); }

  function onPhase(name) {
    if (name === 'head') D.body.classList.add('head-on');
    if (name === 'chrome') {
      D.body.classList.add('chrome-on'); chromeOn = true;
      if (els.panel && S.state === 'closed' && sheetMode()) { setPanel('peek', 'index', !E.instant); }
      pendingToasts.splice(0).forEach(([k, o]) => toast(k, o));
      openDeepLink();
      if (!coachShown) {
        coachShown = true;
        if (!store.get('localStorage', 'dcm:coach')) { store.set('localStorage', 'dcm:coach', '1'); setTimeout(() => { if (!S.place && S.state !== 'half') showCoach(coarse ? 'coach.touch' : 'coach.pointer'); }, E.instant ? 400 : 800); }
      }
    }
  }
  function onState(s) { if (s === 'ready') D.documentElement.dataset.mapState = 'ready'; }
  let deep = null;
  function openDeepLink() {
    if (!deep) return; const d = deep; deep = null;
    if (d.slug) openPlace(d.slug, { history: 'none', source: 'url' });
    else { openIndex(); toast('toast.unknownPlace', { now: true }); try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  }
  function parseDeepLink() {
    const q = new URLSearchParams(location.search).get('place'); if (q == null) return;
    const slug = resolveSlug(q);
    if (slug) { if (slug !== q) { try { history.replaceState(history.state, '', mapUrl(slug)); } catch (e) {} } deep = { slug }; }
    else deep = { slug: null };
  }

  function onData(data) {
    META = data.meta || {}; dataOk = !!data.ok; STR = data.strings || {};
    LIST = (data.places || []).filter(p => p.name);
    if (!dataOk) { toast('toast.dataError', { error: true, now: true, ms: 8000 }); return; }
    LIST.forEach(p => { BY.set(p.slug, p); (p.aliases || []).forEach(a => ALIAS.set(String(a).toLowerCase(), p.slug)); });
    buildChrome();
    relayout(true);
    parseDeepLink();
  }

  function attach(engine) {
    E = engine; reduced = E.REDUCED; coarse = E.COARSE;
    // подсказка, первая подсказка и сообщения не зависят от данных: сообщение об ошибке данных должно показываться и без них
    els.tip = h('div', { id: 'tip', 'aria-hidden': 'true' });
    els.coach = h('div', { id: 'coach', role: 'status' });
    els.toast = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    D.body.append(els.tip, els.coach, els.toast);
    geo = computeGeo(); layout = geo.layout; applyGeo(geo);
    E.initMotion(motionPref());
    const vp = E.els.vp, sc = E.els.scroll;
    vp.addEventListener('pointerdown', onDown); vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp); vp.addEventListener('pointercancel', onUp);
    vp.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') setHover(null); });
    vp.addEventListener('dragstart', e => e.preventDefault()); vp.addEventListener('selectstart', e => e.preventDefault());
    vp.addEventListener('keydown', onKey);
    vp.addEventListener('focus', () => { if (vp.matches(':focus-visible') && !store.get('sessionStorage', 'dcm:kb') && E.state === 'ready') { store.set('sessionStorage', 'dcm:kb', '1'); showCoach('coach.keyboard'); } });
    sc.addEventListener('wheel', onWheel, { passive: false });
    D.addEventListener('click', onClick);
    D.addEventListener('keydown', e => {
      if (e.key === 'Escape' && E.state === 'ready' && (S.state === 'half' || S.state === 'open' || S.place != null)) { closePanel({ source: 'esc' }); }
    });
    D.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('.skip-link');
      if (a) { e.preventDefault(); S.kbd = true; if (S.state === 'half' && S.view === 'index') $('#index-title').focus({ preventScroll: true }); else openIndex({ focus: true }); }
    });
    W.addEventListener('resize', onResize); W.addEventListener('orientationchange', onResize);
    if (W.visualViewport) W.visualViewport.addEventListener('resize', onResize);
    W.addEventListener('popstate', onPop);
    installSkip();
    ['pointerdown', 'keydown', 'wheel'].forEach(t => D.addEventListener(t, () => { if (E.state === 'ready') hideCoach(); }, { capture: true, passive: true }));
    E.on('phase', onPhase); E.on('state', onState);
    E.on('replay', () => { D.body.classList.remove('head-on', 'chrome-on'); chromeOn = false; });
    E.on('glfallback', () => toast('toast.webglFallback', {}));
    E.on('overlay', () => { if (dataOk) bindPlaces(); });
    E.data.then(onData);
    W.__map = {
      state: () => E.state, layout: () => layout, camera: () => ({ z: cam.z, tx: cam.tx, ty: cam.ty }), seaTime: () => E.T,
      placeAt: (x, y) => placeAt(x, y),   // отладка: какое место лежит под точкой экрана
      places: () => LIST.filter(p => E.placeEls.has(p.slug)).map(p => { const a = anchorClient(p.slug); return { slug: p.slug, name: p.name, x: a.x, y: a.y }; }),
      open: slug => openPlace(resolveSlug(slug) || slug, { source: 'api' }), close: () => closePanel({ source: 'api' }), fit: () => { interrupt(); fitCam(220); }, start: () => { interrupt(); startCam(); },   // fit: «Вся карта» (в portrait минимальный масштаб), start: исходный вид (масштаб 1, лист по центру)
      // отладка: окна камеры, бумага, пиксель холста
      geo: () => ({ layout, paper: geo.paper, V: geo.V, free: freeWin(), clampWin: clampWin(), panel: S.state, view: S.view, vw: geo.vw, vh: geo.vh }),
      glPixel: (fx, fy) => E.glPixel(fx, fy), glInfo: () => E.glInfo(),
      flying: () => flying,
    };
  }
  W.DCMUI = { attach };
})();
