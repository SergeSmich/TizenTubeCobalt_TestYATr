// VOT UI — минимальный Leanback-совместимый слой поверх TizenTubeCobalt.
// Подключается ПЕРЕД vot.js (serve_vot.py отдаёт склейку vot_ui.js + vot.js).
// Слой: CSS через adoptedStyleSheets/`style[nonce]`, стек панелей, свой focus-manager
// (D-pad), тосты, реестр действий, настройки в localStorage.
// ES5, без eval, без inline style= (CSP), стили — только CSSOM/stylesheet.
(function () {
  'use strict';

  var BRIDGE = 'http://127.0.0.1:8013';
  var PREF_KEY = 'vot-ui-prefs';
  var Z = '2147483000';

  function log(m) {
    try { console.log('[VOTUI] ' + m); } catch (e) { }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + '/log', true);
      x.send('[VOT-UI] ' + m);
    } catch (e) { }
  }

  // ---------- настройки ----------
  function prefsRead() {
    try {
      var raw = window.localStorage ? localStorage.getItem(PREF_KEY) : null;
      var p = raw ? JSON.parse(raw) : null;
      return (p && typeof p === 'object') ? p : {};
    } catch (e) { return {}; }
  }
  function pref(key, def) {
    var p = prefsRead();
    return (key in p) ? p[key] : def;
  }
  function setPref(key, val) {
    var p = prefsRead();
    p[key] = val;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { }
    try { window.dispatchEvent(new CustomEvent('vot-pref', { detail: { key: key, value: val } })); } catch (e) { }
    fire('pref.' + key, val);
  }

  // ---------- CSS ----------
  var CSS = [
    '#vot-ui-root{position:fixed;left:0;top:0;right:0;bottom:0;z-index:' + Z + ';display:none;',
    'align-items:center;justify-content:center;font-family:Roboto,"Noto Sans",sans-serif;color:#fff;}',
    '#vot-ui-root.vot-open{display:flex;}',
    '#vot-ui-back{position:absolute;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.72);}',
    // Центрирование — flex'ом: связка left/top:50% + translate(-50%,-50%) на ТВ
    // давала сдвиг панели влево и обрезку края. Анимация задаётся из JS
    // inline-стилями (CSS keyframes в Cobalt могут не запускаться).
    // Позиция панели задаётся из JS явными пикселями (см. placePanel): на ТВ
    // layout viewport шире экрана, из-за чего left:50%/flex давали сдвиг влево.
    '#vot-ui-panel{position:absolute;left:0;top:0;width:940px;max-width:94%;max-height:820px;',
    'background:rgba(28,28,28,.98);border-radius:20px;padding:28px 34px;',
    'box-shadow:0 14px 56px rgba(0,0,0,.7);overflow:hidden;transform-origin:50% 50%;}',
    '.vot-h1{font-size:34px;font-weight:500;margin:0 0 4px;}',
    '.vot-sub{font-size:22px;color:rgba(255,255,255,.66);margin:0 0 14px;line-height:1.35;}',
    // Список скроллится сам (пунктов больше, чем влезает по высоте), а
    // render() подводит фокус в видимую область.
    '.vot-list{max-height:600px;overflow-y:auto;}',
    '.vot-row{display:flex;align-items:center;justify-content:space-between;min-height:84px;',
    'padding:0 24px;border-radius:12px;font-size:26px;margin:4px 2px;}',
    '.vot-row.vot-focus{background:rgba(255,255,255,.18);box-shadow:0 0 0 4px #fff inset;}',
    '.vot-row.vot-dis{color:rgba(255,255,255,.45);}',
    '.vot-lab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.vot-val{font-size:24px;color:rgba(255,255,255,.6);margin-left:24px;white-space:nowrap;}',
    '.vot-val.vot-on{color:#7ee081;}',
    '.vot-row.vot-sl{flex-direction:column;align-items:stretch;justify-content:center;',
    'min-height:104px;padding:12px 24px;}',
    '.vot-sl-head{display:flex;align-items:baseline;justify-content:space-between;}',
    '.vot-sl-track{position:relative;height:10px;border-radius:5px;',
    'background:rgba(255,255,255,.22);margin-top:16px;}',
    '.vot-sl-fill{position:absolute;left:0;top:0;height:10px;border-radius:5px;background:#ffb300;}',
    '.vot-sl-knob{position:absolute;top:-8px;width:26px;height:26px;border-radius:13px;',
    'background:#fff;margin-left:-13px;}',
    '.vot-hint{font-size:20px;color:rgba(255,255,255,.48);margin-top:18px;}',
    // Кнопка «Перевод» в баре плеера: включённое состояние = белый кружок с
    // тёмным иероглифом (как у включённых субтитров), смена цвета плавная.
    // Кружок на 5% меньше прежнего (scale .95), подпись всегда белая.
    '[data-vot-toggle]{transition:background-color .18s ease,color .18s ease,fill .18s ease,transform .18s ease;}',
    '[data-vot-toggle="1"]{color:#fff !important;}',
    '[data-vot-toggle="1"][data-vot-on="1"]{background-color:#fff !important;',
    'border-radius:50% !important;transform:scale(.95) !important;transform-origin:50% 50%;}',
    '[data-vot-toggle="1"][data-vot-on="1"] [data-vot-ic="1"],',
    '[data-vot-toggle="1"][data-vot-on="1"] [data-vot-all="1"]{color:#0f0f0f !important;fill:#0f0f0f !important;',
    'stroke:#0f0f0f !important;}',
    '#vot-toast{position:fixed;right:44px;bottom:64px;z-index:2147483100;background:rgba(0,0,0,.86);',
    'border-left:6px solid #ffb300;border-radius:12px;padding:16px 26px;font-size:24px;color:#fff;',
    'max-width:900px;display:none;line-height:1.3;}'
  ].join('');

  var styleDone = false;
  function ensureStyle() {
    if (styleDone) return;
    styleDone = true;
    try {
      if (window.CSSStyleSheet && 'adoptedStyleSheets' in document) {
        var sh = new CSSStyleSheet();
        sh.replaceSync(CSS);
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sh]);
        window.__votUISheet = sh;
        return;
      }
    } catch (e) { log('adopted failed: ' + (e && e.name)); }
    try {
      var ex = document.querySelector('style[nonce]');
      if (ex) { ex.textContent += CSS; return; }
      var st = document.createElement('style');
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    } catch (e2) { log('style failed: ' + (e2 && e2.name)); }
  }

  // ---------- DOM ----------
  var root = null, panelEl = null, listEl = null, titleEl = null, subEl = null, hintEl = null, toastEl = null;
  var cur = null, stack = [];
  var toastTimer = null, geomN = 0;

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build() {
    if (root) return;
    ensureStyle();
    root = mk('div');
    root.id = 'vot-ui-root';
    var back = mk('div');
    back.id = 'vot-ui-back';
    panelEl = mk('div');
    panelEl.id = 'vot-ui-panel';
    titleEl = mk('div', 'vot-h1');
    subEl = mk('div', 'vot-sub');
    listEl = mk('div', 'vot-list');
    hintEl = mk('div', 'vot-hint', 'ВВЕРХ/ВНИЗ — выбор · ВЛЕВО/ВПРАВО — изменить · OK — открыть · BACK — назад');
    panelEl.appendChild(titleEl);
    panelEl.appendChild(subEl);
    panelEl.appendChild(listEl);
    panelEl.appendChild(hintEl);
    root.appendChild(back);
    root.appendChild(panelEl);
    (document.body || document.documentElement).appendChild(root);
    toastEl = mk('div');
    toastEl.id = 'vot-toast';
    (document.body || document.documentElement).appendChild(toastEl);
    log('mounted');
  }

  function valText(v) {
    if (v === true) return 'вкл';
    if (v === false) return 'выкл';
    if (v == null || v === '') return '';
    return String(v);
  }

  function buildRow(it, focused) {
    var isSl = (it.type === 'slider');
    var row = mk('div', 'vot-row' + (isSl ? ' vot-sl' : '') + (focused ? ' vot-focus' : '') + (it.disabled ? ' vot-dis' : ''));
    if (!isSl) {
      row.appendChild(mk('div', 'vot-lab', it.title || ''));
      var val = mk('div', 'vot-val');
      var v = it.value ? it.value() : '';
      val.textContent = valText(v);
      if (v === true) val.className = 'vot-val vot-on';
      row.appendChild(val);
      return row;
    }
    var head = mk('div', 'vot-sl-head');
    head.appendChild(mk('div', 'vot-lab', it.title || ''));
    var sval = mk('div', 'vot-val' + (it.on ? ' vot-on' : ''));
    sval.textContent = valText(it.format ? it.format(it.value()) : it.value());
    head.appendChild(sval);
    var track = mk('div', 'vot-sl-track');
    var min = (it.min == null) ? 0 : it.min, max = (it.max == null) ? 100 : it.max;
    var pct = Math.max(0, Math.min(100, ((it.value() - min) / (max - min)) * 100));
    var fill = mk('div', 'vot-sl-fill');
    fill.style.width = pct + '%';
    var knob = mk('div', 'vot-sl-knob');
    knob.style.left = pct + '%';
    track.appendChild(fill);
    track.appendChild(knob);
    head.appendChild(mk('div', 'vot-val', ''));
    row.appendChild(head);
    row.appendChild(track);
    return row;
  }

  function render() {
    if (!cur) return;
    titleEl.textContent = cur.title || '';
    subEl.textContent = cur.subtitle || '';
    subEl.style.display = cur.subtitle ? 'block' : 'none';
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    for (var i = 0; i < cur.items.length; i++) {
      listEl.appendChild(buildRow(cur.items[i], i === cur.index));
    }
    var f = listEl.children[cur.index];
    if (f && f.scrollIntoView) {
      try { f.scrollIntoView({ block: 'nearest' }); } catch (e) { try { f.scrollIntoView(false); } catch (e2) { } }
    }
  }

  function normItem(it) {
    var o = {};
    for (var k in it) o[k] = it[k];
    if (!o.type) o.type = 'action';
    return o;
  }

  function show(spec) {
    build();
    var items = [], src = spec.items || [];
    for (var i = 0; i < src.length; i++) items.push(normItem(src[i]));
    cur = {
      title: spec.title || '',
      subtitle: spec.subtitle || '',
      items: items,
      index: spec.index || 0
    };
    if (cur.index >= items.length) cur.index = 0;
    closeGen++; // отменяем страховку закрытия предыдущей панели
    root.className = 'vot-open';
    render();
    placePanel();
    animateIn();
    log('panel "' + cur.title + '" items=' + items.length + ' depth=' + stack.length);
  }

  function open(spec) {
    if (cur) {
      stack.push(cur);
      if (stack.length > 8) stack.shift();
    }
    show(spec);
  }

  // Видимая область: position:fixed на ТВ может считаться от layout viewport,
  // который шире экрана, поэтому всё считаем через visualViewport.
  function vpBox() {
    var v = null, w = 0, h = 0, x = 0, y = 0;
    try { v = window.visualViewport; } catch (e) { v = null; }
    try {
      w = (v && v.width) || window.innerWidth || 1920;
      h = (v && v.height) || window.innerHeight || 1080;
      x = (v && v.offsetLeft) || 0;
      y = (v && v.offsetTop) || 0;
    } catch (e2) { w = 1920; h = 1080; }
    return { w: w, h: h, x: x, y: y };
  }

  // Ставим панель по центру видимой области явными пикселями: flex/translate
  // на ТВ давали сдвиг влево и обрезку, потому что layout viewport шире экрана.
  function placePanel() {
    try {
      var b = vpBox();
      var w = Math.min(940, Math.round(b.w * 0.94));
      var mh = Math.min(820, Math.round(b.h * 0.92));
      panelEl.style.width = w + 'px';
      panelEl.style.maxHeight = mh + 'px';
      var lx = Math.round(b.x + (b.w - w) / 2);
      var ly = Math.round(b.y + (b.h - mh) / 2);
      panelEl.style.left = lx + 'px';
      panelEl.style.top = ly + 'px';
      // после вёрстки центрируем по фактической высоте
      var ah = panelEl.offsetHeight || mh;
      if (ah > 0 && ah < mh) ly = Math.round(b.y + (b.h - ah) / 2);
      panelEl.style.top = ly + 'px';
      panelEl.__votL = lx; // цель для анимации «выезда»
      panelEl.__votT = ly;
      if (geomN < 6) {
        geomN++;
        var pr = panelEl.getBoundingClientRect();
        log('geom iw=' + window.innerWidth + 'x' + window.innerHeight + ' vv=' + b.x + ',' + b.y
          + ' ' + Math.round(b.w) + 'x' + Math.round(b.h) + ' panel='
          + Math.round(pr.left) + ',' + Math.round(pr.top) + ' ' + Math.round(pr.width)
          + 'x' + Math.round(pr.height) + ' root=' + root.className);
      }
    } catch (e) { log('geom ERR ' + (e && e.name)); }
  }

  // Поколение закрытия: страховочный таймер не должен «погасить» панель,
  // которую успели открыть заново (иначе на экране пустой полноэкранный слой).
  var closeGen = 0;

  function close() {
    cur = null;
    stack = [];
    if (!root || !panelEl) return;
    var gen = ++closeGen;
    var done = function () {
      if (gen !== closeGen) return;
      try {
        root.className = '';
        root.style.opacity = '';
        panelEl.style.transform = '';
      } catch (e2) { }
    };
    // Закрытие — покадрово из JS (CSS-transition в Cobalt не срабатывает).
    animateOut(done);
    // Страховка: кадры анимации могут не дойти (Cobalt «съедает» rAF при
    // проигрывании видео), и тогда полноэкранный #vot-ui-root остался бы
    // видимым поверх плеера — «пропадает интерфейс, все кнопки».
    setTimeout(done, 400);
    log('close');
  }

  // Появление/закрытие как у нативного оверлея: затемнение проявляется, панель
  // «выезжает» слева с масштабом .94→1. Анимируем ПОКАДРОВО из JS
  // (requestAnimationFrame, при его отсутствии — setTimeout): CSS-transition и
  // @keyframes в Cobalt не запускались, окно появлялось рывком, а изменения
  // `el.style.*` перерисовываются нормально.
  var animTimer = null, animDone = null, animFrames = 0;
  function animRun(dur, apply, done) {
    var useRaf = false, start = -1, timer = null;
    try { useRaf = typeof requestAnimationFrame === 'function'; } catch (e) { useRaf = false; }
    if (animTimer) {
      try { if (useRaf) cancelAnimationFrame(animTimer); else clearTimeout(animTimer); } catch (e1) { }
      animTimer = null;
    }
    animFrames = 1;
    animDone = done || null;
    try { apply(0); } catch (e0) { log('anim ERR ' + (e0 && e0.name)); }
    var tick = function (now) {
      if (start < 0) start = now;
      var k = Math.min(1, (now - start) / dur);
      animFrames++;
      try { apply(k); } catch (e2) { log('anim ERR ' + (e2 && e2.name)); }
      if (k < 1) {
        timer = useRaf ? requestAnimationFrame(tick)
          : setTimeout(function () { tick(now + 20); }, 20);
        animTimer = timer;
        return;
      }
      animTimer = null;
      var d = animDone;
      animDone = null;
      if (d) { try { d(); } catch (e3) { } }
    };
    timer = useRaf ? requestAnimationFrame(tick) : setTimeout(function () { tick(0); }, 20);
    animTimer = timer;
  }

  function animateIn() {
    if (!panelEl) return;
    var b = vpBox();
    var tx = Number(panelEl.__votL || 0), ty = Number(panelEl.__votT || 0);
    var slide = Math.round(Math.min(170, b.w * 0.09));
    animRun(230, function (k) {
      var e = 1 - Math.pow(1 - k, 3); // ease-out
      panelEl.style.left = Math.round(tx - slide * (1 - e)) + 'px';
      panelEl.style.top = ty + 'px';
      panelEl.style.opacity = String(0.15 + 0.85 * e);
      panelEl.style.transform = 'scale(' + (0.94 + 0.06 * e) + ')';
      root.style.opacity = String(0.25 + 0.75 * e);
    }, function () {
      try {
        panelEl.style.left = tx + 'px';
        panelEl.style.top = ty + 'px';
        panelEl.style.opacity = '1';
        panelEl.style.transform = 'scale(1)';
        root.style.opacity = '1';
      } catch (e0) { }
      log('anim in ok frames=' + animFrames + ' slide=' + slide);
    });
  }

  function animateOut(cb) {
    if (!panelEl) { if (cb) cb(); return; }
    var tx = Number(panelEl.__votL || 0), ty = Number(panelEl.__votT || 0);
    animRun(160, function (k) {
      var e = k * k;
      panelEl.style.left = Math.round(tx - 90 * e) + 'px';
      panelEl.style.top = ty + 'px';
      panelEl.style.opacity = String(Math.max(0, 1 - e));
      root.style.opacity = String(Math.max(0, 1 - e));
    }, function () {
      try {
        root.style.opacity = '';
        panelEl.style.opacity = '';
      } catch (e0) { }
      log('anim out ok frames=' + animFrames);
      if (cb) { try { cb(); } catch (e1) { } }
    });
  }

  function back() {
    if (stack.length) {
      cur = stack.pop();
      render();
    } else {
      close();
    }
  }

  function step(it, dir) {
    var min = (it.min == null) ? 0 : it.min, max = (it.max == null) ? 100 : it.max;
    var s = it.step || 5;
    var v = Number(it.value()) + dir * s;
    if (v < min) v = min;
    if (v > max) v = max;
    v = Math.round(v / s) * s;
    if (it.onChange) it.onChange(v);
    // Событие нужно только слайдерам, объявившим pref: без него fire('pref.')
    // уходил в никуда (у наших слайдеров сохранение делает onChange).
    if (it.pref) fire('pref.' + it.pref, v);
    log('slider "' + String(it.title).slice(0, 24) + '" = ' + v);
    render();
  }

  function activate() {
    if (!cur) return;
    var it = cur.items[cur.index];
    if (!it || it.disabled) return;
    log('pick "' + String(it.title).slice(0, 28) + '" type=' + (it.type || 'action')
      + ' val=' + (it.value ? String(it.value()).slice(0, 24) : ''));
    if (it.type === 'slider') {
      if (it.onSelect) it.onSelect(it.value());
      return;
    }
    if (it.type === 'choice') {
      var opts = (it.options ? it.options() : []) || [];
      var items = [];
      var self = it;
      for (var i = 0; i < opts.length; i++) {
        items.push({
          title: opts[i].label,
          type: 'action',
          value: function (o) { return function () { return String(o.value) === String(self.value()) ? '•' : ''; }; }(opts[i]),
          onSelect: function (o) {
            return function () { if (self.onPick) self.onPick(o.value); back(); };
          }(opts[i])
        });
      }
      open({ title: cur.title, subtitle: it.title, items: items });
      return;
    }
    if (it.onSelect) {
      var r = it.onSelect();
      if (r === 'keep') return;
      render();
    }
  }

  // ---------- действия ----------
  var actions = {};
  function on(name, cb) { actions[name] = cb; }
  function fire(name, arg) {
    var cb = actions[name];
    if (!cb) return undefined;
    try { return cb(arg); } catch (e) { log('action ' + name + ' failed: ' + (e && e.message)); }
    return undefined;
  }

  // ---------- тост ----------
  function toast(msg, ms) {
    build();
    toastEl.textContent = String(msg);
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, ms || 3800);
  }

  // ---------- клавиши ----------
  var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, BACK: 27, MENU: 18, F3: 114, F4: 115, F5: 116 };

  function navLog(dir) {
    var it = cur && cur.items[cur.index];
    log('nav ' + dir + ' i=' + (cur ? cur.index : -1) + '/' + (cur ? cur.items.length : 0)
      + ' "' + (it ? String(it.title).slice(0, 24) : '-') + '" type=' + (it ? (it.type || 'action') : '-'));
  }

  function onKey(e) {
    var kc = e.keyCode;
    var nav = (kc === KEY.UP || kc === KEY.DOWN || kc === KEY.LEFT || kc === KEY.RIGHT ||
      kc === KEY.ENTER || kc === KEY.BACK || kc === KEY.MENU);
    if (cur) {
      if (nav) { e.preventDefault(); e.stopPropagation(); }
      if (e.type !== 'keydown') return;
      if (kc === KEY.UP) {
        cur.index = (cur.index - 1 + cur.items.length) % (cur.items.length || 1);
        navLog('up');
        render();
      } else if (kc === KEY.DOWN) {
        cur.index = (cur.index + 1) % (cur.items.length || 1);
        navLog('down');
        render();
      } else if (kc === KEY.LEFT) {
        var li = cur.items[cur.index];
        if (li && li.type === 'slider') step(li, -1);
      } else if (kc === KEY.RIGHT) {
        var ri = cur.items[cur.index];
        if (ri && ri.type === 'slider') step(ri, 1);
      } else if (kc === KEY.ENTER) {
        activate();
      } else if (kc === KEY.BACK) {
        back();
      } else if (kc === KEY.MENU) {
        close();
      }
      return;
    }
    if (e.type !== 'keydown') return;
    if (kc === KEY.F4) { e.preventDefault(); e.stopPropagation(); fire('menu.toggle'); }
    else if (kc === KEY.F3) { e.preventDefault(); e.stopPropagation(); fire('translate.toggle'); }
    else if (kc === KEY.MENU) { e.preventDefault(); e.stopPropagation(); fire('menu.toggle'); }
  }

  // ---------- инициализация ----------
  var inited = false;
  function init() {
    if (inited) return;
    if (!document.body) { setTimeout(init, 250); return; }
    inited = true;
    build();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    log('init ok adopted=' + (window.__votUISheet ? 1 : 0));
  }

  window.VOTUI = {
    version: '0.2',
    log: log,
    init: init,
    open: open,
    close: close,
    back: back,
    isOpen: function () { return !!cur; },
    render: render,
    toast: toast,
    on: on,
    fire: fire,
    pref: pref,
    setPref: setPref,
    KEY: KEY
  };
})();

;
//# sourceURL=http://127.0.0.1:8013/vot.js
(function () {
  'use strict';

  // ======================================================================
  // VOT overlay v2 — Yandex voice-over translation for TizenTubeCobalt.
  // Loaded via bootstrap (jsdelivr) -> fetch+eval from the in-app bridge at
  // http://127.0.0.1:8013 (all Yandex traffic + mp3 playback happen in Java).
  // v2 adds an on-screen status pill showing the request lifecycle.
  // ======================================================================

  var BRIDGE = 'http://127.0.0.1:8013';
  var SYNC_THRESHOLD = 1.5;
  var SYNC_INTERVAL = 1000;
  var SEEK_COOLDOWN = 3000;
  var POLL_BASE = 3000;
  var POLL_MAX = 5000;
  // When the answer carries no "remaining" hint we cannot size the sleep, so we
  // fast-poll a few times (the audio usually appears in a couple of seconds),
  // then back off — the same idea as vot.js (3 s -> 5 s -> 10 s -> 20 s) instead
  // of hammering the server every 3 s for minutes.
  var POLL_NO_HINT = 3000;
  var POLL_FAST_TRIES = 3;
  var POLL_SLOW = 8000;
  var POLL_SLOW_MAX = 20000;
  // How long we keep asking Yandex while the PC is downloading/uploading the
  // source audio. The PC needs 30-150 s (download + 10 chunks), and Yandex
  // answers 6 the whole time, so the normal "status 6 = dead end" logic must
  // not apply - it used to kill the translation 5 s after the fill started.
  var PC_FILL_WAIT = 600000;
  // How long we wait for the page player to actually land on 0:00 when we
  // rewind the video as the translation starts.
  var RESTART_MAX_WAIT = 4000;
  // Сколько ждём язык оригинала, когда перевод уже готов, а язык ещё неизвестен
  // (перевод не запускаем, пока не знаем, что ролик не на исключённом языке).
  // Быстрый детектор на ПК отвечает за ~0.4-1 с, yt-dlp-фолбэк — до 10 с;
  // таймаут ограничивает худший случай, чтобы перевод не потерялся навсегда.
  var LANG_GATE_MS = 6000;
  // Паузы между опросами языка оригинала: первый ответ ПК отдаёт за 0.4-1 с
  // (быстрый детектор), поэтому первые попытки частые — иначе язык приезжал
  // только через 2.5 с и гейт старта зря тормозил.
  var META_GAPS = [400, 600, 900, 1500, 2500, 2500, 2500, 2500, 2500];
  var MARK = 'VOT-OVERLAY-V14';

  // Повторная инъекция того же скрипта в ту же страницу (TizenTube подгружает
  // userScript на некоторых переходах) не должна плодить таймеры, MutationObserver
  // и слушатели клавиш: иначе через несколько минут в странице живут десятки
  // экземпляров оверлея, и интерфейс плеера начинает «пропадать»/подтормаживать.
  // Новый код всё равно применяется только после перезапуска приложения.
  try {
    if (window.__VOT_OVERLAY_MARK === MARK) {
      try { console.log('[VOT] overlay already active (' + MARK + ') -> skip re-init'); } catch (e0) { }
      return;
    }
    window.__VOT_OVERLAY_MARK = MARK;
  } catch (e) { }

  var state = {
    curId: null,
    busy: false,
    active: false,
    audioPaused: false,
    loop: false,
    partial: false,
    curUrl: null,
    title: '',
    translationId: null,
    audioUploaded: false,
    audioIdx: 0,
    uploading: false,
    retried: false,
    cfg: null,
    livelyVoice: false,
    // Yandex keys its per-video translation cache by the *source* language
    // shard (field 8). vot.js/SmartTube send "en", and that shard is filled by
    // everybody, so it is almost always warm: the answer comes back in ~0.3 s.
    // We used to send "auto", which is a separate, nearly empty shard — every
    // request started a fresh synthesis (~50 s) or ended in status 6.
    lang: 'en',
    // Язык оригинала (с ПК) и последний статус для панели. Пустые по умолчанию:
    // язык становится известен асинхронно, после /fill_status.
    origLang: '',
    uiStatus: '',
    altLangTried: false,
    audioTried: false,
    playedOnce: false,
    restarting: false,
    lastSeek: 0,
    // id ролика, перевод которого отменён навсегда: язык оригинала оказался
    // исключённым (skipLang). Сбрасывается при смене ролика.
    skipLangBlock: null,
    // id ролика, для которого пользователь вручную включил перевод кнопкой:
    // ручное включение обходит правило skipLang.
    forceTranslate: null,
    // id ролика, для которого пользователь ВЫКЛЮЧИЛ перевод кнопкой в баре:
    // выключение действует только на текущий ролик, следующий переводится сам
    // (глобально перевод гасит prefs «translate.enabled»).
    offForId: null,
    // Последнее вычисленное состояние кнопки: пока идёт переход между роликами
    // (curId = null), подсветку не дёргаем — кнопка не должна мигать «выкл».
    paintOn: null,
    // URL перевода, готового к запуску: ролик был на паузе, стартуем вместе с ним.
    pendingPlay: null,
    // Перевод уже готов, но язык оригинала ещё неизвестен: держим звук, пока
    // не выясним, что ролик не на исключённом языке (см. gateReady).
    gate: null,
    // id ролика, для которого пользователь включил перевод кнопкой: подсветка
    // кнопки должна стать белой СРАЗУ по нажатию, ещё до ответа Яндекса.
    wantOn: null,
    pcTried: false,
    pcDeadline: 0,
    pcFailed: false,
    pcDone: false,
    pcWaits: 0,
    // Сколько раз продлевали ожидание ПК-филлера после «timeout waiting»
    // (сервер синтезирует дольше своего max_wait). Кэп — в handleResp.
    pcExtends: 0,
    // Сколько опросов сделано для текущего ролика: по нему растёт пауза, когда
    // сервер не прислал подсказку remaining (иначе спали бы опросы подряд).
    polls: 0,
    // Путь E (audioMode:"capture"): звук, который штатный плеер уже получил по
    // SABR и отдал в MSE, пишется в мост как cache/cap_<videoId>.mp4.
    capTried: false,
    capBusy: false,
    capFailed: false,
    capTries: 0,
    capSentSize: 0,
    // Сколько времени держим один translationId на status=6 и сколько опросов
    // сделано: по ним видно, что сервер досчитывает сам (см. holdSix).
    sixSince: 0,
    sixWaits: 0
  };

  var statusEl = null;

  function log(m) {
    try { console.log('[VOT] ' + m); } catch (e) { }
    bridgeLog('[VOT] ' + m);
  }

  function bridgeLog(m) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + '/log', true);
      x.send(m);
    } catch (e) { }
  }

  try {
    window.addEventListener('error', function (e) {
      bridgeLog('[VOT] onerror ' + (e && e.message ? e.message : '') +
        ' @' + (e && e.filename ? e.filename : '') + ':' + (e && e.lineno ? e.lineno : ''));
    });
    window.addEventListener('unhandledrejection', function (e) {
      bridgeLog('[VOT] unhandledrejection ' +
        (e && e.reason && e.reason.message ? e.reason.message : String(e && e.reason)));
    });
  } catch (e) { }

  // ---- on-screen status pill (styled via CSSOM — inline style attr is CSP-blocked)
  var barEl = null, barFill = null, barTimer = null, barStart = 0, barRem = 0;

  function ensureStatus() {
    if (statusEl) return statusEl;
    try {
      var el = document.createElement('div');
      el.id = 'vot-status';
      var s = el.style;
      s.position = 'fixed';
      s.top = '72px';
      s.right = '20px';
      s.zIndex = '2147483647';
      s.background = 'rgba(0,0,0,0.82)';
      s.color = '#fff';
      s.padding = '10px 14px';
      s.borderRadius = '6px';
      s.borderLeft = '4px solid #90a4ae';
      s.fontFamily = 'Roboto, Arial, sans-serif';
      s.fontSize = '16px';
      s.lineHeight = '1.4';
      s.maxWidth = '440px';
      s.pointerEvents = 'none';
      s.whiteSpace = 'pre-wrap';
      s.wordBreak = 'break-word';
      // Шкала ожидания перевода живёт отдельным узлом: textContent у контейнера
      // стёр бы её, поэтому текст пишем в дочерний <div>.
      var txt = document.createElement('div');
      txt.id = 'vot-status-text';
      txt.textContent = MARK + ' — ожидание видео';
      el.appendChild(txt);
      var bar = document.createElement('div');
      var bs = bar.style;
      bs.height = '4px';
      bs.marginTop = '8px';
      bs.borderRadius = '2px';
      bs.background = 'rgba(255,255,255,0.18)';
      bs.overflow = 'hidden';
      bs.display = 'none';
      var fill = document.createElement('div');
      var fs = fill.style;
      fs.height = '100%';
      fs.width = '0%';
      fs.background = '#f5a623';
      bar.appendChild(fill);
      el.appendChild(bar);
      (document.body || document.documentElement).appendChild(el);
      statusEl = el;
      barEl = bar;
      barFill = fill;
    } catch (e) { }
    return statusEl;
  }

  // CSS-анимации в Cobalt не запускаются (проверено), поэтому шкалу двигаем
  // покадрово из JS: 12 кадров/с хватает и почти не грузит ТВ.
  function barTick() {
    if (!barFill) return;
    var t = (Date.now() - barStart) / 1000;
    if (t < 0) t = 0;
    if (barRem > 0) {
      // Доля = сколько ждём / (сколько ждём + сколько осталось). Оценка Яндекса
      // завышена в ~3 раза, но шкала честная: только растёт и не доходит до
      // 100%, пока сервер не отдаст перевод.
      barFill.style.marginLeft = '0%';
      barFill.style.width = Math.min(92, (t / (t + barRem)) * 100).toFixed(1) + '%';
    } else {
      // Подсказки remaining нет — бегущий сегмент: видно, что процесс живой.
      barFill.style.width = '26%';
      barFill.style.marginLeft = (((Date.now() - barStart) % 1400) / 1400 * 74).toFixed(1) + '%';
    }
    barTimer = setTimeout(barTick, 80);
  }

  // prog: число (осталось секунд, шкала растёт) | 'wait' (бегущий сегмент) |
  // undefined (прячем шкалу — перевод готов/ошибка).
  function setProgress(prog) {
    if (!barEl) return;
    if (prog === undefined || prog === null || prog === false) {
      if (barTimer) { clearTimeout(barTimer); barTimer = null; }
      barStart = 0;
      barRem = 0;
      barEl.style.display = 'none';
      return;
    }
    if (!barStart) barStart = Date.now();
    barRem = (typeof prog === 'number' && isFinite(prog) && prog > 0) ? prog : 0;
    barEl.style.display = 'block';
    if (!barTimer) barTimer = setTimeout(barTick, 0);
  }

  function setStatus(text, color, prog) {
    try { state.uiStatus = String(text || ''); } catch (e0) { }
    try {
      var el = ensureStatus();
      if (!el) return;
      var txt = el.firstChild;
      if (txt && txt.nodeType === 1) txt.textContent = text;
      else el.textContent = text;
      el.style.borderLeft = '4px solid ' + (color || '#90a4ae');
      setProgress(prog);
    } catch (e) { }
  }

  function http(method, path, body, cb, err) {
    var x = new XMLHttpRequest();
    x.open(method, BRIDGE + path, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status === 200) {
        try { cb(JSON.parse(x.responseText)); } catch (e) { (err || function () {})(e); }
      } else {
        var t = '';
        try { t = String(x.responseText || '').slice(0, 220); } catch (e2) { }
        (err || function () {})(new Error('http ' + x.status + (t ? ' ' + t : '')));
      }
    };
    x.onerror = function () { (err || function () {})(new Error('network')); };
    x.send(body ? JSON.stringify(body) : null);
  }

  function getVideoId() {
    var m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(String(location.href));
    return m ? m[1] : null;
  }

  function findVideo() {
    var vs = document.querySelectorAll('video');
    var best = null;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      var d = v.duration > 0 ? v.duration : 0;
      if (!best || d > (best.duration > 0 ? best.duration : 0)) best = v;
    }
    var res = best || (vs.length ? vs[0] : null);
    if (res) { try { hookVideoEvents(res); } catch (e) { } }
    return res;
  }

  // Ролик поставили на паузу или запустили — реагируем сразу, не ожидая тика
  // синхронизации, иначе звук перевода отстаёт от картинки до секунды.
  function hookVideoEvents(v) {
    if (!v || v.__votEv) return;
    v.__votEv = 1;
    try {
      v.addEventListener('pause', function () {
        if (state.active && !state.audioPaused) {
          state.audioPaused = true;
          log('sync pause reason=paused(ev)');
          http('POST', '/pause', { }, function () { }, function () { });
        }
        schedulePaint();
      });
      v.addEventListener('play', function () {
        if (state.active && state.audioPaused) {
          state.audioPaused = false;
          log('sync resume(ev)');
          http('POST', '/resume', { }, function () { }, function () { });
        }
        if (state.pendingPlay) {
          var u = state.pendingPlay;
          state.pendingPlay = null;
          log('deferred play -> start');
          beginPlayback(u, null);
        }
        schedulePaint();
      });
    } catch (e) { log('video events ERR ' + (e && e.message)); }
  }

  function currentVideoTime() {
    var v = findVideo();
    return v ? (Number(v.currentTime) || 0) : 0;
  }

  function probeYtcfg() {
    try {
      var c = window.ytcfg;
      if (!c) { log('ytcfg absent'); return; }
      log('ytcfg.get=' + typeof c.get);
      var dk = [];
      if (c.data_ && typeof c.data_ === 'object') {
        for (var k in c.data_) { if (c.data_.hasOwnProperty(k) && dk.length < 50) dk.push(k); }
        log('ytcfg.data_ keys=' + dk.join(','));
      }
      function getv(p) { try { return c.get ? c.get(p) : null; } catch (e) { return null; } }
      var pv = getv('PLAYER_VARS');
      if (pv && typeof pv === 'object') {
        var pvk = [];
        for (var k2 in pv) { if (pv.hasOwnProperty(k2) && pvk.length < 40) pvk.push(k2); }
        log('PLAYER_VARS keys=' + pvk.join(','));
      }
      var pc = getv('PLAYER_CONFIG');
      if (pc && typeof pc === 'object') {
        var pck = [];
        for (var k3 in pc) { if (pc.hasOwnProperty(k3) && pck.length < 20) pck.push(k3); }
        log('PLAYER_CONFIG keys=' + pck.join(','));
        if (pc.args && typeof pc.args === 'object') {
          var ak = [];
          for (var a in pc.args) { if (pc.args.hasOwnProperty(a) && ak.length < 30) ak.push(a); }
          log('PLAYER_CONFIG.args keys=' + ak.join(','));
          if (pc.args.player_response) {
            log('args.player_response type=' + typeof pc.args.player_response +
              (typeof pc.args.player_response === 'string' ? ' len=' + pc.args.player_response.length : ''));
          }
        }
      }
      try {
        var s = JSON.stringify(c.data_);
        log('ytcfg has streamingData=' + (s.indexOf('streamingData') !== -1) +
          ' adaptiveFormats=' + (s.indexOf('adaptiveFormats') !== -1) +
          ' playerResponse=' + (s.indexOf('playerResponse') !== -1));
      } catch (e) { log('ytcfg stringify err ' + e); }
    } catch (e) { log('ytcfg probe err ' + e); }
  }

  function probeLang() {
    try {
      var wpc = (window.ytcfg && window.ytcfg.get) ? window.ytcfg.get('WEB_PLAYER_CONTEXT_CONFIGS') : null;
      log('WPC type=' + typeof wpc);
      if (wpc && typeof wpc === 'object') {
        try {
          var wk = [];
          for (var wk0 in wpc) { if (wpc.hasOwnProperty(wk0) && wk.length < 30) wk.push(wk0); }
          log('WPC keys=' + wk.join(','));
          var s = JSON.stringify(wpc);
          log('WPC len=' + s.length);
          var m = s.match(/(?:originalLanguage|languageCode|captionTracks|"lang"|"language"|audioTrack|displayName)[^,}\]]{0,30}/g);
          log('WPC lang signals=' + (m ? m.slice(0, 15).join(' | ') : 'none'));
        } catch (e) { log('WPC parse err ' + e); }
      }
      var v = findVideo();
      if (v) {
        try { log('video textTracks=' + v.textTracks.length + ' audioTracks=' + v.audioTracks.length); } catch (e) { }
      }
      try {
        var ys = JSON.stringify(window._yttv);
        var m2 = ys.match(/(?:originalLanguage|languageCode|"lang"|"language"|audioTrack)[^,}\]]{0,30}/g);
        log('yttv lang signals=' + (m2 ? m2.slice(0, 15).join(' | ') : 'none') + ' (len=' + ys.length + ')');
      } catch (e) { log('yttv stringify err ' + e); }
    } catch (e) { log('lang probe err ' + e); }
  }

  function watchUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

  function qparam(s, key) {
    var m = new RegExp('[?&]' + key + '=([^&#]*)').exec(s);
    return m ? m[1] : null;
  }

  function gvProbes() {
    if (!window.performance || !performance.getEntriesByType) { log('perf: no getEntriesByType'); return; }
    var list = performance.getEntriesByType('resource');
    if (!list || !list.length) { log('perf: 0 resource entries'); return; }
    var gv = [];
    for (var i = 0; i < list.length; i++) {
      var nm = String(list[i].name || '');
      if (nm.indexOf('googlevideo') !== -1) gv.push(nm);
    }
    log('perf entries=' + list.length + ' googlevideo=' + gv.length);
    for (var k = 0; k < gv.length && k < 8; k++) {
      var it = qparam(gv[k], 'itag') || qparam(gv[k], 'itag%3D') || null;
      var isAudio = /ms=au|mime=audio|itag%3D(139|140|141|249|250|251)|itag=(139|140|141|249|250|251)/i.test(gv[k]);
      log('gvurl itag=' + (it || '?') + (isAudio ? ' AUDIO' : '') + ' ' + gv[k].slice(0, 1600));
    }
  }

  function probeYttv() {
    try {
      var y = window._yttv;
      log('yttv type=' + typeof y);
      if (!y) return;
      var keys = [];
      for (var k in y) { if (y.hasOwnProperty(k) && keys.length < 40) keys.push(k); }
      log('yttv keys=' + keys.join(','));
      if (y.player && typeof y.player === 'object') {
        var pk = [];
        for (var p in y.player) { if (y.player.hasOwnProperty(p) && pk.length < 40) pk.push(p); }
        log('yttv.player keys=' + pk.join(','));
      }
      if (y.playerApi && typeof y.playerApi === 'object') {
        var ak = [];
        for (var a in y.playerApi) { if (y.playerApi.hasOwnProperty(a) && ak.length < 40) ak.push(a); }
        log('yttv.playerApi keys=' + ak.join(','));
      }
    } catch (e) { log('yttv probe err ' + e); }
    ['ytInitialPlayerResponse', 'ytcfg', 'ytplayer'].forEach(function (g) {
      if (typeof window[g] !== 'undefined') log('global ' + g + ' type=' + typeof window[g]);
    });
  }

  function probeAudio() {
    try {
      var pr = null;
      var ypr = window.ytInitialPlayerResponse;
      if (ypr && typeof ypr === 'object') pr = ypr;
      if (!pr) {
        var pc = (window.ytcfg && window.ytcfg.get) ? window.ytcfg.get('PLAYER_CONFIG') : null;
        if (pc && pc.args && pc.args.player_response) {
          var raw = pc.args.player_response;
          pr = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        }
      }
      if (!pr) { log('audio probe: no player_response'); return; }
      var sd = pr.streamingData;
      if (!sd) { log('audio probe: no streamingData keys=' + Object.keys(pr).join(',')); return; }
      log('audio probe: sd keys=' + Object.keys(sd).join(','));
      var af = sd.adaptiveFormats || [];
      var plain = 0, cipher = 0, sample = '', minLen = 0, maxLen = 0;
      for (var i = 0; i < af.length; i++) {
        var f = af[i];
        if (!f || !f.mimeType || f.mimeType.indexOf('audio') !== 0) continue;
        if (f.url) { plain++; if (!sample) sample = f.mimeType + ' itag=' + f.itag + ' urlLen=' + f.url.length; }
        else cipher++;
      }
      log('audio probe: adaptive=' + af.length + ' audio plain=' + plain +
          ' cipher=' + cipher + ' first=' + sample +
          ' sabr=' + (sd.serverAbrStreamingUrl ? 'yes' : 'no'));
    } catch (e) { log('audio probe err ' + e); }
  }

  function ytcfgGet(k, def) {
    try { if (window.ytcfg && ytcfg.get) { var v = ytcfg.get(k); if (v) return v; } } catch (e) { }
    return def;
  }

  function pickAudio(formats) {
    var aud = [], i, best = null;
    for (i = 0; i < (formats || []).length; i++) {
      var f = formats[i];
      if (f && f.mimeType && f.mimeType.indexOf('audio') === 0 && f.url) aud.push(f);
    }
    for (i = 0; i < aud.length; i++) { if (String(aud[i].itag) === '251') { best = aud[i]; break; } }
    if (!best) { for (i = 0; i < aud.length; i++) { if (String(aud[i].itag) === '140') { best = aud[i]; break; } } }
    if (!best) best = aud[0] || null;
    return best ? { url: best.url, itag: Number(best.itag) || 0 } : null;
  }

  // The page's own player response is the cheapest source: no bot-check at all.
  function localAudio() {
    var cands = [];
    function push(x) { if (x) cands.push(x); }
    try { push(window.ytInitialPlayerResponse); } catch (e) { }
    try {
      var pc = ytcfgGet('PLAYER_CONFIG', null);
      if (pc && pc.args) push(pc.args.player_response);
    } catch (e) { }
    try {
      var pv = ytcfgGet('PLAYER_VARS', null);
      if (pv && pv.player_response) push(pv.player_response);
    } catch (e) { }
    try {
      if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
        push(window.ytplayer.config.args.player_response);
      }
    } catch (e) { }
    for (var i = 0; i < cands.length; i++) {
      try {
        var pr = cands[i];
        if (typeof pr === 'string') pr = JSON.parse(pr);
        if (!pr || !pr.streamingData) continue;
        var got = pickAudio(pr.streamingData.adaptiveFormats);
        if (got) return got;
      } catch (e) { }
    }
    return null;
  }

  // Ask YouTube InnerTube for a plain DASH audio URL. ANDROID_VR is tried
  // first (plain URLs, no cipher), then IOS as fallback.
  var INNER_CLIENTS = [
    {
      name: 'ANDROID_VR', id: 28, version: '1.60.19',
      client: { deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32,
                osName: 'Android', osVersion: '12L' }
    },
    {
      name: 'IOS', id: 5, version: '19.29.1',
      client: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.5.0.22F76' }
    },
    {
      name: 'ANDROID', id: 3, version: '19.29.37',
      client: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' }
    }
  ];

  function innertubeAudio(videoId, cb, err) {
    var local = localAudio();
    if (local) { log('audio local itag=' + local.itag); cb(local); return; }
    var visitor = ytcfgGet('VISITOR_DATA', '');
    var idx = 0, lastErr = 'no client';

    function attempt() {
      if (idx >= INNER_CLIENTS.length) { (err || function () {})(lastErr); return; }
      var cl = INNER_CLIENTS[idx++];
      var client = {
        clientName: cl.name, clientVersion: cl.version,
        hl: 'en', gl: 'US', utcOffsetMinutes: 0,
        visitorData: visitor || undefined
      };
      var k;
      for (k in cl.client) if (cl.client.hasOwnProperty(k)) client[k] = cl.client[k];

      var key = ytcfgGet('INNERTUBE_API_KEY', 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8');
      var x = new XMLHttpRequest();
      x.open('POST', 'https://www.youtube.com/youtubei/v1/player?key=' + encodeURIComponent(key), true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.setRequestHeader('X-Youtube-Client-Name', String(cl.id));
      x.setRequestHeader('X-Youtube-Client-Version', cl.version);
      if (visitor) x.setRequestHeader('X-Goog-Visitor-Id', visitor);
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status !== 200) {
          lastErr = cl.name + ' http ' + x.status + ' ' + String(x.responseText || '').slice(0, 120);
          log('audio inner ' + lastErr);
          attempt();
          return;
        }
        var j;
        try { j = JSON.parse(x.responseText); } catch (e) { lastErr = 'json ' + e; log('audio inner ' + lastErr); attempt(); return; }
        var st = j && j.playabilityStatus && j.playabilityStatus.status;
        if (st !== 'OK') {
          lastErr = cl.name + ' playability=' + st +
            (j && j.playabilityStatus && j.playabilityStatus.reason ? ' ' + j.playabilityStatus.reason : '');
          log('audio inner ' + lastErr);
          attempt();
          return;
        }
        var best = pickAudio(j.streamingData && j.streamingData.adaptiveFormats);
        if (!best) { lastErr = cl.name + ' no audio url'; log('audio inner ' + lastErr); attempt(); return; }
        log('audio inner ok client=' + cl.name + ' itag=' + best.itag);
        cb(best);
      };
      x.onerror = function () { lastErr = cl.name + ' network'; attempt(); };
      x.send(JSON.stringify({
        context: { client: client },
        videoId: videoId,
        contentCheckOk: true,
        racyCheckOk: true
      }));
    }

    attempt();
  }

  // Serverless: спрашиваем url у МОСТА. Мост сам ходит в InnerTube с куками
  // телевизора (ANDROID_VR), поэтому ни ПК, ни запрос из страницы не нужны.
  // Возвращает {url, itag}; url с `n` пока отдаём ошибкой (решателя нет).
  function bridgeAudio(videoId, cb, err) {
    http('GET', '/yt_url?videoId=' + encodeURIComponent(videoId) + '&client=vr', null,
      function (r) {
        if (!r || !r.status) { (err || function () {})(new Error('bridge: empty answer')); return; }
        if (r.status !== 'OK') {
          (err || function () {})(new Error('bridge: ' + r.status + ' ' + String(r.reason || '').slice(0, 120)));
          return;
        }
        var list = r.formats || [], best = null, withN = 0, i, f, k;
        var order = ['251', '140'];
        for (i = 0; i < list.length; i++) if (list[i] && list[i].n) withN++;
        for (k = 0; k < order.length && !best; k++) {
          for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f && !f.n && String(f.itag) === order[k]) { best = f; break; }
          }
        }
        for (i = 0; i < list.length && !best; i++) if (list[i] && !list[i].n) best = list[i];
        log('audio bridge vr fmt=' + list.length + ' withN=' + withN + ' login=' + (r.loggedIn ? 1 : 0) +
            (best ? ' pick itag=' + best.itag : ' none'));
        if (!best) { (err || function () {})(new Error('url needs n (' + withN + ')')); return; }
        cb({ url: best.url, itag: Number(best.itag) || 0 });
      }, err);
  }

  // status 6 (AUDIO_REQUESTED): download the source audio via the bridge and
  // upload it to Yandex, then continue polling for the finished translation.
  // Вызывается только из ветки audioMode:"on" (закрытый путь, см. STATE.md);
  // на обычном status=6 мы держим живой tid, а не грузим звук.
  function uploadAudio(id, dur, tid) {
    if (!tid) { state.busy = false; setStatus('Перевод: нет translationId для аудио', '#e53935'); return; }
    if (state.uploading) return;
    if (state.audioUploaded) { poll(id, dur, 30); return; }
    state.uploading = true;
    state.translationId = tid;
    setStatus('Перевод: ищу исходный звук…', '#f5a623', 'wait');
    var local = !!(state.cfg && state.cfg.audioMode === 'local');
    log('audio lookup id=' + id + ' tid=' + tid + ' mode=' + (local ? 'local' : 'page'));
    var onSrc = function (a) {
      log('audio src itag=' + a.itag + ' url=' + String(a.url).slice(0, 60));
      setStatus('Перевод: скачиваю и загружаю звук…\nitag=' + a.itag, '#f5a623', 'wait');
      http('POST', '/audio',
        { videoUrl: watchUrl(id), translationId: tid, audioUrl: a.url, itag: a.itag },
        function (r) {
          state.uploading = false;
          state.audioUploaded = true;
          log('audio upload ok size=' + r.size);
          setStatus('Перевод: звук загружен, жду перевод…', '#f5a623', 'wait');
          poll(id, dur, 5);
        },
        function (e) { state.uploading = false; state.busy = false; setStatus('Перевод: не удалось загрузить звук\n' + e, '#e53935'); log('audio upload ERR ' + e); });
    };
    var onErr = function (e) {
      state.uploading = false;
      state.busy = false;
      setStatus('Перевод: не удалось получить звук\n' + e, '#e53935');
      log('audio inner ERR ' + e);
    };
    if (local) bridgeAudio(id, onSrc, onErr);
    else innertubeAudio(id, onSrc, onErr);
  }

  // Serverless-путь для status=6: мост сам минтит poToken, берёт аудио-URL у
  // InnerTube (ANDROID_VR → WEB), скачивает дорожку и грузит её в Яндекс
  // (/audiosrc). Ни ПК, ни скачивания в странице не участвуют. Возвращает true,
  // если запрос ушёл (дальше ждём поллингом).
  function bridgeAudioSrc(id, dur, tid) {
    if (!tid) { state.busy = false; setStatus('Перевод: нет translationId для аудио', '#e53935'); return false; }
    if (state.uploading) return true;
    if (state.audioUploaded) return false;
    state.uploading = true;
    state.translationId = String(tid);
    log('audiosrc id=' + id + ' tid=' + tid);
    setStatus('Перевод: готовлю звук ролика…\nэто займёт до минуты', '#f5a623', 'wait');
    http('POST', '/audiosrc',
      { videoId: id, translationId: String(tid), videoUrl: watchUrl(id) },
      function (r) {
        state.uploading = false;
        state.audioUploaded = true;
        state.busy = false;
        log('audiosrc ok client=' + (r && r.client || '?') + ' itag=' + (r && r.itag) +
            ' size=' + (r && r.size));
        setStatus('Перевод: звук загружен, жду перевод…', '#f5a623', 'wait');
        poll(id, dur, 5);
      },
      function (e) {
        state.uploading = false;
        state.busy = false;
        log('audiosrc ERR ' + e);
        if (state.curId !== id) return;
        // Звук не ушёл — не сдаёмся, держим живой tid как раньше.
        setStatus('Перевод: звук не отправился, жду сервер…', '#f5a623', 'wait');
        holdSix(id, dur, {}, 'audiosrc-failed');
      });
    return true;
  }

  // Ask the PC dev server to download the track and push it into the Yandex
  // cache for the shard the TV is currently polling (state.lang). Shared by the
  // status=6 and status=0 ladders so both failures end in the same recovery.
  function pcFill(id, dur, r, why) {
    if (state.curId !== id) return; // stale callback from the previous video
    state.pcTried = true;
    state.pcDeadline = Date.now() + PC_FILL_WAIT;
    state.busy = false;
    var tidPc = String((r && r.translationId) || state.translationId || '');
    log(why + ' -> pc fill id=' + id + ' tid=' + tidPc + ' lang=' + state.lang);
    setStatus('Перевод: ПК готовит звук…\nобычно до минуты', '#f5a623', 'wait');
    http('POST', '/fill',
      { videoId: id, duration: dur, tid: tidPc, lang: state.lang },
      function (fr) {
        log('fill queued ' + JSON.stringify(fr || {}));
        poll(id, dur, 120);
      },
      function (e) {
        log('fill ERR ' + e);
        state.busy = false;
        setStatus('Перевод: ПК недоступен\n' + e, '#e53935');
      });
  }

  // ---- Путь E: звук из MSE -------------------------------------------------
  // Player-ответ больше не содержит прямых googlevideo-ссылок (url=0/audioUrl=0,
  // только SABR), поэтому скачать дорожку самим нельзя. Зато штатный плеер уже
  // качает её и отдаёт в MSE: vot_net.js перехватывает appendBuffer аудио и
  // пишет байты в мост (cache/cap_<videoId>.mp4). Здесь мы ждём, пока наберётся
  // достаточно, и отдаём файл Яндексу как исходный звук.
  var CAP_STEP_MS = 4000;   // шаг опроса размера файла
  var CAP_MIN_MS = 12000;   // раньше не отдаём: init + первые сегменты
  var CAP_MAX_MS = 45000;   // дольше ждать нельзя: окно Яндекса ~90 с
  var CAP_ENOUGH = 4000000; // 4 МБ ≈ 4 мин AAC 128k — дальше не ждём
  var CAP_STABLE = 120 * 1024; // рост меньше этого = плеер упёрся в буфер
  var CAP_MIN_BYTES = 250000;

  function capStatus(id, cb) {
    http('GET', '/cap/status?videoId=' + encodeURIComponent(id), null,
      function (j) { cb(null, j || {}); },
      function (e) { cb(e || new Error('capture status')); });
  }

  function capFillAllowed() {
    if (!state.cfg || state.cfg.audioMode !== 'capture') return false;
    if (uiPref('capture.enabled', true) === false) return false;
    if (state.capFailed) return false;
    if (state.capBusy) return false;
    // Одна загрузка на ролик: повторный PUT в тот же translationId может
    // испортить уже идущую задачу Яндекса.
    if ((state.capTries || 0) >= 1) return false;
    return true;
  }

  function capUpload(id, dur, tid, size) {
    if (state.curId !== id) return;
    state.capBusy = false;
    state.capTries = (state.capTries || 0) + 1;
    state.capSentSize = size;
    log('capture upload id=' + id + ' size=' + size + ' tid=' + tid);
    setStatus('Перевод: загружаю звук (' + Math.round(size / 1024) + ' КБ)…', '#f5a623', 'wait');
    http('POST', '/cap/upload?videoId=' + encodeURIComponent(id) +
      '&translationId=' + encodeURIComponent(tid) + '&itag=140', null,
      function (j) {
        if (state.curId !== id) return;
        state.audioUploaded = true;
        log('capture upload ok size=' + (j && j.size) + ' ms=' + (j && j.ms));
        setStatus('Перевод: звук загружен, жду перевод…', '#f5a623', 'wait');
        poll(id, dur, 5);
      },
      function (e) {
        if (state.curId !== id) return;
        state.capFailed = true;
        state.busy = false;
        log('capture upload ERR ' + e);
        setStatus('Перевод: не удалось загрузить звук\n' + e, '#e53935');
      });
  }

  // Returns true if it took over the recovery; false lets the caller run the
  // usual ladder (other shard -> PC filler).
  function capFill(id, dur, r, why) {
    if (state.curId !== id) return true;
    var tid = String((r && r.translationId) || state.translationId || '');
    if (!tid) return false;
    state.capTried = true;
    state.capBusy = true;
    state.busy = false;
    state.translationId = tid;
    log(why + ' -> capture id=' + id + ' tid=' + tid + ' lang=' + state.lang);
    setStatus('Перевод: записываю звук с плеера…', '#f5a623', 'wait');
    var t0 = Date.now();
    var prev = -1;
    var step = function () {
      if (state.curId !== id || !state.capBusy) return;
      capStatus(id, function (err, j) {
        if (state.curId !== id || !state.capBusy) return;
        var size = err ? 0 : Number(j.fileCurrent ? j.size : (j.fileSize || 0)) || 0;
        var el = Date.now() - t0;
        var grew = prev >= 0 ? size - prev : size;
        prev = size;
        if (size > 0) {
          var enough = size >= CAP_ENOUGH
            || (size >= CAP_MIN_BYTES && grew >= 0 && grew < CAP_STABLE);
          if (el >= CAP_MAX_MS || (el >= CAP_MIN_MS && enough)) {
            capUpload(id, dur, tid, size);
            return;
          }
          setStatus('Перевод: записываю звук с плеера…\n' + Math.round(size / 1024) + ' КБ',
            '#f5a623', 'wait');
          setTimeout(step, CAP_STEP_MS);
          return;
        }
        if (el >= CAP_MAX_MS) {
          // Плеер не отдал ни байта (ролик на паузе, другой контейнер): обычная
          // лестница — другой шард, затем ПК-филлер.
          state.capBusy = false;
          state.capFailed = true;
          log('capture empty after ' + Math.round(el / 1000) + 's -> ladder');
          if (escalate(id, dur, r, why)) return;
          state.busy = false;
          setStatus('Перевод: не удалось получить звук\nролик пропущен', '#e53935');
          return;
        }
        setTimeout(step, CAP_STEP_MS);
      });
    };
    step();
    return true;
  }

  // status=6 (AUDIO_REQUESTED) — НЕ терминальный и НЕ повод бросать задачу.
  // Замеры 26.10: (а) тот же tid `X23-S8hAa3c` отдал 6, а через ~3.5 мин — 1,
  // (б) на «мёртвых» `l08V8bNg53I`/`1GZ5pFwdU2M` 6 → 2 → терминальный 0.
  // Отличить (а) от (б) по ответу нельзя, поэтому держим tid и опрашиваем:
  // каждая новая firstRequest=true создаёт НОВУЮ задачу и бросает живую —
  // отсюда прежнее «попытка 1 из 3 → и никогда».
  // fail-audio-js + пустое аудио (трюк форка SmartTube) проверен A/B: статус
  // 200 {"status":1}, задача оживает, но сервер считает звук НЕдоставленным и
  // через 51 с уходит в терминальный 0 (fid роли не играет) — хуже ожидания,
  // поэтому не отправляем (см. STATE.md).
  var SIX_HOLD_MS = 30000;    // пауза между опросами, пока сервер «готовит звук»
  var SIX_HOLD_MAX = 240000;  // 4 мин на один шард: с загруженным звуком сервер
                              // отвечает за ~1 мин, дальше — другой шард/ПК

  function holdSix(id, dur, r, why) {
    var tid6 = r.translationId || state.translationId;
    var now = Date.now();
    if (!state.sixSince) state.sixSince = now;
    var waited = now - state.sixSince;
    if (!tid6 || waited > SIX_HOLD_MAX) {
      log(why + ' -> give up holding tid=' + tid6 + ' after ' + Math.round(waited / 1000) + 's');
      state.sixSince = 0;
      state.sixWaits = 0;
      return false;
    }
    state.sixWaits = (state.sixWaits || 0) + 1;
    state.busy = false;
    log(why + ' -> hold tid=' + tid6 + ' waited=' + Math.round(waited / 1000)
      + 's n=' + state.sixWaits);
    poll(id, dur, r.remaining != null ? r.remaining : -1, SIX_HOLD_MS);
    return true;
  }

  function pcFillAllowed() {
    // Лог и решение должны совпадать: раньше отсутствие конфига писалось как
    // «cfg_off=1», хотя филлер в этом случае разрешён.
    if (uiPref('pcFill.enabled', true) === false) { log('pcFill denied: pref off'); return false; }
    if (state.cfg && state.cfg.pcFill === false) { log('pcFill denied: cfg off'); return false; }
    if (state.pcTried) { log('pcFill denied: already tried'); return false; }
    return true;
  }

  // Both shards are dead (or the task id is terminal): the same ladder as
  // status=6 — look in the other shard, then let the PC fill the cache.
  function escalate(id, dur, r, why) {
    if (!state.altLangTried && uiPref('otherShard.enabled', true) !== false) {
      state.altLangTried = true;
      state.retried = false; // a fresh shard means a fresh task id: retry again
      // Новый шард = новая задача: у неё свой бюджет ожидания на status=6.
      state.sixSince = 0;
      state.sixWaits = 0;
      var alt = (state.lang === 'en') ? 'auto' : 'en';
      state.busy = false;
      log(why + ' -> other shard lang=' + alt);
      setStatus('Перевод: ищу в другом кэше…', '#f5a623', 'wait');
      setTimeout(function () { if (state.curId === id) startTranslation(id, dur, alt); }, 200);
      return true;
    }
    if (pcFillAllowed()) { pcFill(id, dur, r, why); return true; }
    return false;
  }

  // Single response handler for both the first request and the polls.
  function handleResp(r, id, dur, fallbackRem) {
    // A poll scheduled for the previous video can land after the user switched:
    // acting on it would poison altLangTried/pcTried/retried for the new video.
    if (state.curId !== id) return;
    // Язык оригинала пришёл позже и оказался исключённым (русский): перевод
    // уже не нужен, не начинаем воспроизведение и не тратим запросы.
    if (state.skipLangBlock === id) { state.busy = false; return; }
    log('resp status=' + r.status + ' tid=' + r.translationId + (r.remaining != null ? ' rem=' + r.remaining : '') +
      ' lively=' + (r.lively ? 1 : 0) + (r.lang ? ' lang=' + r.lang : '') +
      (r.allow === false ? ' allow=0' : '') + (r.shouldRetry === false ? ' retry=0' : ''));
    if (r.translationId) state.translationId = r.translationId;
    if (r.lively) state.livelyVoice = true;
    // Поле 8 ответа — язык оригинала от самого Яндекса. Оно приходит уже в
    // первом ответе (~1-2 с), поэтому решение «ролик на исключённом языке»
    // больше не ждёт yt-dlp на ПК (холодный кэш ~10 с). Проверяем ДО запуска
    // звука: иначе русский ролик успевал заиграть на секунду и глох.
    if (r.lang) {
      var rl = String(r.lang).toLowerCase();
      if (rl !== state.origLang) {
        state.origLang = rl;
        log('resp lang=' + rl + ' (field 8)');
      }
      maybeSkipNow(id, rl);
      if (state.skipLangBlock === id) { state.busy = false; return; }
    }
    if (r.status === 1 && r.audioUrl) {
      // Успех: бюджет ожидания на status=6 отработан, следующий 6 (например,
      // после выключения/включения кнопкой) должен снова получить свои 10 мин.
      state.sixSince = 0;
      state.sixWaits = 0;
      state.busy = false;
      gateReady(id, r.audioUrl, false);
      return;
    }
    // status 5 = partial_ready: the audio URL already works, only the tail of
    // the video is still being translated. Start playing right away instead
    // of waiting for the full file (~20 s later).
    if (r.status === 5 && r.audioUrl) {
      state.sixSince = 0;
      state.sixWaits = 0;
      state.busy = false;
      gateReady(id, r.audioUrl, true);
      poll(id, dur, r.remaining != null ? r.remaining : fallbackRem);
      return;
    }
    // While the PC filler runs, Yandex keeps answering 6 (audio requested) or 0
    // (nothing yet) until the bytes land. Waiting is the whole point here, so
    // never let those codes reach the failure branches below.
    if (state.pcTried && !state.pcDone && (r.status === 6 || r.status === 0)) {
      state.busy = false;
      // ПК-филлер уже упал (нет куки / yt-dlp не смог скачать звук). Опрос
      // дальше бессмысленен, но и молча выходить нельзя: на экране оставалось
      // старое «ПК готовит звук…», и пользователь не понимал, что случилось.
      if (state.pcFailed) {
        log('fill failed -> stop polling status=' + r.status);
        setStatus('Перевод: сервер не отдаёт этот ролик\nПК-филлер не смог скачать звук', '#e53935');
        return;
      }
      if (!state.pcDeadline) state.pcDeadline = Date.now() + PC_FILL_WAIT;
      var left = Math.round((state.pcDeadline - Date.now()) / 1000);
      if (left <= 0) {
        log('fill timeout, giving up');
        setStatus('Перевод: ПК не справился\nвыберите другой ролик', '#e53935');
        return;
      }
      // Every few waits ask the bridge how the PC job is doing: a dead filler
      // (expired cookies, no yt-dlp) must not keep the user waiting 10 minutes,
      // and a finished one means Yandex has the audio now — a fresh first
      // request then reads the cache instead of leaning on the old verdict.
      state.pcWaits = (state.pcWaits || 0) + 1;
      if (state.pcWaits % 4 === 1) {
        http('GET', '/fill_status?videoId=' + encodeURIComponent(id), null, function (fr) {
          if (!fr || state.curId !== id || state.pcFailed || state.pcDone) return;
          if (fr.state === 'ok') {
            state.pcDone = true;
            state.pcDeadline = 0;
            log('fill done on PC -> re-request');
            setStatus('Перевод: звук загружен, проверяю…', '#3fb950');
            startTranslation(id, dur, state.lang);
            return;
          }
          if (fr.state === 'err' || fr.state === 'offline') {
            var why = (fr.res && (fr.res.error || fr.res.status)) || fr.state;
            // "timeout waiting for the translation" — это НЕ провал филлера:
            // звук уже загружен, Яндекс просто ещё синтезирует (у нас замер
            // 648-секундного ролика: status=3, rem≈175с, дольше max_wait ПК).
            // Раньше мы гасили опрос и показывали ошибку, хотя перевод вот-вот
            // должен был появиться. Продолжаем ждать своим опросом.
            if (/timeout waiting/i.test(String(why))) {
              // Продлеваем ожидание, но не бесконечно: /fill_status помнит
              // последний результат и отдаёт его вечно, так что без счётчика
              // провалившаяся задача держала бы опрос часами.
              state.pcExtends = (state.pcExtends || 0) + 1;
              if (state.pcExtends <= 5) {
                log('fill: server still synthesizing (' + why + ') -> keep polling n=' + state.pcExtends);
                state.pcDeadline = Math.max(state.pcDeadline || 0, Date.now() + 120000);
                return;
              }
              log('fill: still synthesizing after ' + state.pcExtends + ' extensions, giving up');
            }
            state.pcFailed = true;
            state.pcDeadline = 0;
            state.busy = false;
            log('fill failed state=' + fr.state + ' why=' + why);
            setStatus('Перевод: ПК не смог\n' + String(why).slice(0, 90), '#e53935');
          }
        }, function () { });
      }
      log('fill wait status=' + r.status + ' left=' + left + 's');
      // poll() sets its own status text, so set ours after it to keep the
      // "PC is preparing the audio" message visible during the whole wait.
      poll(id, dur, 2);
      setStatus('Перевод: ПК готовит звук…\nещё до ' + left + 'с', '#f5a623', left > 0 ? left : 'wait');
      return;
    }
    if (r.status === 0) {
      state.busy = false;
      var msg = r.message || '';
      // A failed verdict right after our own audio upload usually means Yandex
      // could not decode that format/track: try the next audio candidate before
      // giving up (SmartTube does the same with its format list).
      if (state.audioUploaded && (PR_ALL[id] || []).length > (state.audioIdx || 0) + 1) {
        state.audioIdx = (state.audioIdx || 0) + 1;
        log('status=0 after audio -> next candidate idx=' + state.audioIdx);
        setStatus('Перевод: пробую другой звук…', '#f5a623');
        uploadRealAudio(id, dur, state.translationId);
        return;
      }
      // Поле 11 (allowToTranslateVideo) = 0 значит «это видео перевести нельзя»:
      // ни повтор, ни другой шард, ни ПК-филлер вердикт не изменят, поэтому
      // отказываем сразу, а не после 40-секундной лестницы. После нашей
      // загрузки звука флагу не верим: там 0 означал «не смог декодировать».
      if (r.allow === false && !state.audioUploaded) {
        log('status=0 allow=0 -> terminal msg=' + msg);
        setStatus('Перевод: сервер отказывается переводить этот ролик', '#e53935');
        return;
      }
      // "Не удается перевести видео, попробуйте позже" is often transient: retry
      // the first request once before giving up. Yandex caches the verdict by
      // translationId and answers in ~0.1 s, so this retry costs almost nothing.
      // Поле 12 (shouldRetry) = 0 говорит, что повтор бессмысленен — тот же
      // вердикт лежит в кэше по этому translationId. Другой шард (escalate)
      // всё равно остаётся: там задача другая.
      if (!state.retried && r.shouldRetry !== false && /позже|later|try/i.test(msg)) {
        state.retried = true;
        log('retry after status=0 msg=' + msg);
        setStatus('Перевод: повторяю запрос…', '#f5a623', 'wait');
        setTimeout(function () { if (state.curId === id) startTranslation(id, dur); }, 2000);
        return;
      }
      if (r.shouldRetry === false) log('status=0 retry=0 -> no repeat msg=' + msg);
      // status=0 is terminal for this translationId only, and the task id lives
      // in one shard: the other shard may still hold a working cache entry (and
      // whatever we get there can be filled from the PC). Without this ladder a
      // single dead task made the video untranslatable forever.
      if (escalate(id, dur, r, 'status=0')) return;
      if (state.pcDone) {
        log('status=0 after fill -> failed');
        setStatus('Перевод: сервер не принял звук\nвыберите другой ролик', '#e53935');
        return;
      }
      log('FAILED msg=' + msg);
      setStatus('Перевод: не удалось\n' + msg, '#e53935');
      return;
    }

    if (r.status === 6) {
      // AUDIO_REQUESTED: Yandex wants the source file for this video — it has no
      // cache entry for it and cannot pull the track from YouTube itself anymore
      // (the empty-buffer "failaudio" trick only makes the countdown tick and
      // still ends in status 0, proved by vot_probe.py fix6). First look in the
      // other language shard: the cache is keyed by field 8 and "en" is the shard
      // the browser clients fill; then let the PC dev server fill it (yt-dlp with
      // the browser cookies downloads the track there and uploads it, after which
      // this very video turns into status=1; nothing is downloaded on the TV).
      // Поле 11 при status=6 НЕ трактуем как отказ: «нужен звук» — это обычный
      // ответ для ролика без кэша, и ПК-филлер его лечит. Только пишем в лог,
      // чтобы по прогонам понять, приходит ли флаг вместе с 6.
      if (r.allow === false) log('status=6 allow=0 (ignored: audio can still be supplied) msg=' + (r.message || ''));
      // Путь E идёт первым: звук уже на ТВ, запросы к YouTube не нужны, бот-гейт
      // не участвует, а translationId остаётся тем самым, который опрашивает ТВ.
      var tid6 = r.translationId || state.translationId;
      // Serverless: мост сам скачивает звук и грузит его в Яндекс, ПК не нужен.
      if (tid6 && !state.audioTried && state.cfg && state.cfg.audioMode === 'local') {
        state.audioTried = true;
        if (bridgeAudioSrc(id, dur, tid6)) return;
      }
      if (tid6 && capFillAllowed() && capFill(id, dur, r, 'status=6')) return;
      // Держим тот же translationId и опрашиваем: новый firstRequest здесь
      // только вредит — он создаёт новую задачу и бросает живую (замер: тот же
      // tid отдал 6, а через ~3.5 мин — status=1 с url).
      if (holdSix(id, dur, r, 'status=6')) return;
      if (escalate(id, dur, r, 'status=6')) return;
      state.busy = false;
      // Both shards are empty. Handing Yandex the real audio is what the browser
      // extension does, but on this TV it cannot work: every innerTube client
      // either answers LOGIN_REQUIRED or returns googlevideo urls without a valid
      // poToken, and the player itself never sends one (it plays through MSE from
      // SABR, where the token lives inside the native stack). Kept behind
      // `audioMode:"on"` only, so the normal path stays instant.
      if (tid6 && !state.audioTried && state.cfg && state.cfg.audioMode === 'on') {
        state.audioTried = true;
        state.busy = false;
        state.translationId = String(tid6);
        log('status=6 -> real audio tid=' + tid6);
        setStatus('Перевод: нужен звук ролика…\nищу аудиопоток', '#f5a623');
        withAudioFormat(id, function (fmt) {
          if (!fmt) {
            log('no audio stream -> give up');
            setStatus('Перевод: не удалось получить звук\nролик пропущен', '#e53935');
            return;
          }
          uploadRealAudio(id, dur, tid6);
        });
        return;
      }
      state.busy = false;
      if (state.pcDone) {
        // The PC did upload the track and Yandex still answers "audio requested":
        // the upload was refused (wrong container) or the cache is cold for this
        // shard. Nothing left to try from here.
        log('status=6 after fill -> failed');
        setStatus('Перевод: сервер не принял звук\nвыберите другой ролик', '#e53935');
        return;
      }
      log('status=6 dead (both shards empty)');
      setStatus('Перевод: сервер не отдаёт этот ролик\nвыберите другой', '#e53935');
      return;
    }
    poll(id, dur, r.remaining != null ? r.remaining : fallbackRem);
  }

  // ---- real audio: InnerTube player -> audio stream URL -------------------
  // Cobalt keeps streaming data out of reach of JS (ytcfg has no
  // player_response), but the page can ask InnerTube with its own context:
  // client name/version/visitor data taken from ytcfg. That is the same
  // context the TV player used to start playback of this very video.
  var PR_FMT = {}; // videoId -> audio format (InnerTube probe result)
  var PR_ALL = {}; // videoId -> all audio formats found (fallback order)

  function withAudioFormat(id, cb) {
    if (PR_FMT[id]) { cb(PR_FMT[id]); return; }
    innerTubePlayer(id, function (f) {
      if (f) PR_FMT[id] = f;
      cb(f);
    });
  }

  // The TV/TVHTML5 context answers with SABR only (streamingData has
  // serverAbrStreamingUrl and no per-format url). Other client identities asked
  // from the same page sometimes do hand out a plain url: on the TV only MWEB
  // ever did, and only intermittently (1 of 5 probes gave url=22 aud=17, the
  // rest answered LOGIN_REQUIRED), so the client list is walked in several
  // cycles. Costs ~1 request each, all local to the TV.
  // YouTube keys differ per client family: the web key with an Android client
  // answers HTTP 400 Precondition check failed instead of a player response, so
  // each entry names the key and the extra headers that client expects.
  var PR_KEYS = {
    web: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    android: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ios: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc'
  };
  var PR_UA = {}; // videoId -> User-Agent of the client that produced the url
  var PR_CLIENTS = [
    { name: 'MWEB', id: 2, v: '2.20241202.08.00', key: 'web',
      ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/122.0.6261.64 Mobile Safari/537.36,gzip(gfe)' },
    { name: 'ANDROID_VR', id: 28, v: '1.60.19', key: 'android',
      ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; en_US; ' +
          'Quest 3 Build/SQ3A.220605.009.A1;) gzip' },
    { name: 'WEB', id: 1, v: '2.20241202.01.00', key: 'web', ua: '' },
    { name: 'IOS', id: 5, v: '19.45.4', key: 'ios',
      ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)' },
    { name: 'ANDROID', id: 3, v: '19.44.38', key: 'android',
      ua: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip' },
    { name: 'WEB_EMBEDDED_PLAYER', id: 56, v: '1.20241202.01.00', key: 'web', third: 1, ua: '' },
    { name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', id: 85, v: '2.0', key: 'page', third: 1, ua: '' }
  ];
  var PR_CYCLES = 3;

  function prContext(base, c) {
    var ctx = { client: {} };
    var bc = (base && base.client) || {};
    var cl = ctx.client;
    cl.clientName = c.name;
    cl.clientVersion = c.v;
    cl.hl = bc.hl || 'en';
    cl.gl = bc.gl || 'US';
    if (bc.visitorData) cl.visitorData = bc.visitorData;
    if (c.android || c.name === 'ANDROID' || c.name === 'IOS' || c.name === 'ANDROID_VR') {
      cl.androidSdkVersion = 30;
      cl.osName = 'Android';
      cl.osVersion = '11';
    }
    if (c.third) ctx.thirdParty = { embedUrl: 'https://www.youtube.com/' };
    if (base && base.user) ctx.user = base.user;
    return ctx;
  }

  function playerProbe(id, c, cb) {
    try {
      var base = ytcfgGet('INNERTUBE_CONTEXT', null);
      var key = (c.key === 'page' && ytcfgGet('INNERTUBE_API_KEY', '')) || PR_KEYS[c.key] || PR_KEYS.web;
      var body = JSON.stringify({
        context: prContext(base, c),
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true
      });
      var x = new XMLHttpRequest();
      x.open('POST', '/youtubei/v1/player?key=' + key + '&prettyPrint=false', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.setRequestHeader('X-YouTube-Client-Name', String(c.id));
      x.setRequestHeader('X-YouTube-Client-Version', c.v);
      // Android/iOS endpoints reject the request outright without this one.
      if (c.key === 'android' || c.key === 'ios') {
        x.setRequestHeader('X-Goog-Api-Format-Version', '2');
      }
      if (c.ua) x.setRequestHeader('User-Agent', c.ua);
      x.onload = function () {
        try {
          var d = JSON.parse(x.responseText);
          var ps = (d && d.playabilityStatus) || {};
          var sd = (d && d.streamingData) || {};
          var ad = (sd.adaptiveFormats || []).concat(sd.formats || []);
          var nUrl = 0, cip = 0, naud = 0, auds = [];
          for (var i = 0; i < ad.length; i++) {
            var f = ad[i];
            var isAud = typeof f.mimeType === 'string' && f.mimeType.indexOf('audio') === 0;
            if (f.url) nUrl++;
            if (f.signatureCipher || f.cipher) cip++;
            if (isAud && f.url) {
              naud++;
              auds.push(f);
            }
          }
          log('PR ' + c.name + ' http=' + x.status + ' ps=' + ps.status + ' n=' + ad.length +
            ' url=' + nUrl + ' cip=' + cip + ' aud=' + naud +
            (ps.reason ? ' rs=' + String(ps.reason).substring(0, 30) : '') +
            ((d && d.error && d.error.message) ? ' err=' + String(d.error.message).substring(0, 40) : ''));
          // SmartTube's order: m4a first, then the cheapest track. A 30-minute
          // video then stays a few megabytes (the bridge holds it in memory) and
          // Yandex gets a format it accepts most often.
          auds.sort(function (a, b) {
            var am = a.mimeType.indexOf('mp4a') === 0 ? 0 : 1;
            var bm = b.mimeType.indexOf('mp4a') === 0 ? 0 : 1;
            if (am !== bm) return am - bm;
            return (a.bitrate || 1e9) - (b.bitrate || 1e9);
          });
          // The bridge holds the whole track in memory: drop candidates above
          // 45 MB unless nothing else is left.
          var small = [];
          for (var s = 0; s < auds.length; s++) {
            var cl = parseInt(auds[s].contentLength || '0', 10) || 0;
            if (cl > 0 && cl <= 47185920) small.push(auds[s]);
          }
          if (small.length) auds = small;
          cb(auds);
        } catch (e) { log('PR ' + c.name + ' parse err ' + e); cb(null); }
      };
      x.onerror = function () { log('PR ' + c.name + ' xhr err'); cb(null); };
      x.send(body);
    } catch (e) { log('PR ' + c.name + ' err ' + e); cb(null); }
  }

  function innerTubePlayer(id, cb) {
    var cycle = 0, i = 0, found = null;
    function step() {
      if (found) { cb(found); return; }
      if (i >= PR_CLIENTS.length) {
        i = 0;
        cycle++;
        if (cycle >= PR_CYCLES) {
          log('PR no client gave an audio url (' + PR_CYCLES + ' cycles)');
          cb(null);
          return;
        }
        setTimeout(step, 400);
        return;
      }
      var c = PR_CLIENTS[i++];
      playerProbe(id, c, function (auds) {
        if (auds && auds.length) {
          PR_ALL[id] = auds;
          PR_UA[id] = c.ua || '';
          found = auds[0];
          log('PR WIN ' + c.name + ' cycle=' + cycle + ' cands=' + auds.length +
            ' itag=' + found.itag + ' mime=' + String(found.mimeType).substring(0, 20) +
            ' br=' + (found.bitrate || '?') + ' len=' + String(found.url).length +
            ' host=' + String(found.url).split('/')[2]);
        }
        step();
      });
    }
    step();
  }

  // Upload one audio candidate (state.audioIdx) to Yandex through the bridge.
  // If Yandex still ends with status 0, the caller advances audioIdx and this is
  // called again with the next format.
  function uploadRealAudio(id, dur, tid) {
    var list = PR_ALL[id] || [];
    var fmt = list[state.audioIdx || 0];
    if (!fmt) {
      state.busy = false;
      log('audio: no candidate left');
      setStatus('Перевод: сервер не отдаёт этот ролик\nзвук не подошёл', '#e53935');
      return;
    }
    state.audioUploaded = true;
    setStatus('Перевод: загружаю звук ролика…\nitag=' + fmt.itag, '#f5a623');
    log('audio upload start itag=' + fmt.itag + ' idx=' + (state.audioIdx || 0) +
      '/' + list.length + ' tid=' + tid + ' br=' + (fmt.bitrate || '?'));
    http('POST', '/audio',
      { videoUrl: watchUrl(id), translationId: String(tid), audioUrl: fmt.url, itag: fmt.itag,
        ua: PR_UA[id] || '' },
      function (r) {
        log('audio upload ok ' + JSON.stringify(r));
        setStatus('Перевод: звук отправлен\nсервер синтезирует голос…', '#f5a623');
        state.busy = true;
        poll(id, dur, 90);
      },
      function (e) {
        state.busy = false;
        log('audio upload ERR ' + e);
        // The googlevideo url is IP/time bound; a failed download is worth one
        // more attempt with the next format (it is a different host).
        if ((state.audioIdx || 0) + 1 < list.length) {
          state.audioIdx = (state.audioIdx || 0) + 1;
          uploadRealAudio(id, dur, tid);
          return;
        }
        setStatus('Перевод: не удалось загрузить звук\n' + e, '#e53935');
      });
  }

  function startTranslation(id, dur, lang, metaTries) {
    if (state.busy) return;
    if (state.skipLangBlock === id) { state.busy = false; return; }
    // Новая операция перевода (кнопка, смена языка, другой шард) — свой бюджет
    // ожидания на status=6: иначе накопленный sixSince мгновенно уводил бы её
    // в эскалацию, не дав подождать.
    state.sixSince = 0;
    state.sixWaits = 0;
    // Пользователь выключил перевод кнопкой в баре именно для этого ролика.
    if (state.offForId === id) { state.busy = false; log('translate skipped: off by button id=' + id); return; }
    if (uiPref('translate.enabled', true) === false) {
      state.busy = false;
      log('translate skipped: disabled by button id=' + id);
      setStatus('Перевод выключен\nвключить: кнопка 文A в баре (или F4)', '#90a4ae');
      return;
    }
    // Перевод нужен «с иностранного на русский», поэтому по умолчанию
    // исключён русский: ролик на русском переводить не надо. Ручное нажатие
    // кнопки «Перевод: выкл» (state.forceTranslate) правило игнорирует.
    var skip = (state.forceTranslate === id) ? '' : String(uiPref('skipLang', 'ru') || '').toLowerCase();
    var orig = String(state.origLang || '').toLowerCase();
    // Язык оригинала приходит с ПК асинхронно (yt-dlp, холодный кэш ~10 с).
    // Если решить сразу, русский ролик успеет уехать в перевод — ждём метаданные.
    if (skip && !orig) {
      var mt = metaTries || 0;
      // Язык оригинала теперь приходит и в первом ответе Яндекса (поле 8),
      // поэтому yt-dlp больше не на критическом пути: одна короткая попытка
      // поймать тёплый кэш метаданных (~0.1–0.4 с), дальше стартуем сразу.
      // Если язык окажется исключённым, handleResp гасит перевод ДО запуска
      // звука (maybeSkipNow) — русский ролик не успевает заиграть.
      if (mt < 1) {
        log('translate waiting for source lang try=' + (mt + 1) + ' id=' + id);
        setTimeout(function () {
          if (state.curId === id) startTranslation(id, dur, lang, mt + 1);
        }, 500);
        return;
      }
      log('translate: source lang unknown, starting anyway id=' + id);
    }
    if (skip && orig && langBase(orig) === langBase(skip)) {
      state.busy = false;
      log('translate skipped: source lang=' + orig + ' matches skipLang=' + skip + ' id=' + id);
      setStatus('Перевод: ролик на языке «' + langLabel(orig) + '»\n(исключён в настройках)', '#90a4ae');
      return;
    }
    state.busy = true;
    state.lang = (lang && lang !== 'auto') ? lang : (uiPref('shard', 'auto') === 'en' ? 'en' : (lang || state.lang || 'en'));
    state.title = (typeof document.title === 'string') ? document.title : '';
    setStatus('Перевод: отправляю запрос…\nvideo=' + id + ' · ' + Math.round(dur) + 'с', '#f5a623');
    log('translate start id=' + id + ' dur=' + dur.toFixed(1) + ' lang=' + state.lang);
    http('POST', '/translate',
      { videoUrl: watchUrl(id), duration: dur, firstRequest: true, lang: state.lang, targetLang: 'ru', title: state.title },
      function (r) { handleResp(r, id, dur, 30); },
      function (e) { state.busy = false; setStatus('Перевод: ошибка запроса\n' + e, '#e53935'); log('translate ERR ' + e); });
  }

  function poll(id, dur, remaining, holdMs) {
    // Перевод отменён (язык исключён) — не тратим запросы и поллинг.
    if (state.skipLangBlock === id) { state.busy = false; return; }
    // remaining приходит из ответа (поле 5) и может отсутствовать. Раньше
    // «нет подсказки» превращалось в Math.min(..., >NaN<) и setTimeout(NaN) =
    // мгновенный повтор: шторм запросов к Яндексу. Теперь «неизвестно» = -1.
    var rem = (typeof remaining === 'number' && isFinite(remaining)) ? remaining : -1;
    if (rem === 0 && !(holdMs > 0)) { state.busy = false; setStatus('Перевод: нет готового перевода', '#e53935'); return; }
    state.polls = (state.polls || 0) + 1;
    var delay;
    if (holdMs > 0) {
      // status=6: сервер сам тянет звук. Пауза фиксированная и длинная, чтобы
      // не долбить /translate, и не зависит от rem (он там врёт: 57 → 1 через
      // считанные минуты).
      delay = holdMs;
    } else if (rem < 0) {
      delay = (state.polls <= POLL_FAST_TRIES)
        ? POLL_NO_HINT
        : Math.min(POLL_SLOW * (state.polls - POLL_FAST_TRIES), POLL_SLOW_MAX);
    } else {
      // The server hint ("rem=71") is very conservative: in practice the
      // translation shows up much sooner, so never sleep longer than POLL_MAX.
      delay = Math.min(Math.max(POLL_BASE, rem * 1000), POLL_MAX);
    }
    setStatus((holdMs > 0
      ? 'Перевод: сервер готовит звук…'
      : (state.active ? 'Перевод: играю, доготовится…' : 'Перевод: в очереди/переводится…')) +
      (rem > 0 ? ' (~' + rem + 'с)' : ''), '#f5a623', rem > 0 ? rem : 'wait');
    log('poll in ' + (delay / 1000).toFixed(0) + 's rem=' + rem + ' n=' + state.polls);
    setTimeout(function () {
      // За время ожидания перевод мог быть отменён (пришёл язык из skipLang).
      if (state.skipLangBlock === id || state.curId !== id) { state.busy = false; return; }
      http('POST', '/translate',
        { videoUrl: watchUrl(id), duration: dur, firstRequest: false, lang: state.lang || 'en', targetLang: 'ru' },
        function (r) { handleResp(r, id, dur, rem > 0 ? Math.max(3, rem - 1) : -1); },
        function (e) { state.busy = false; setStatus('Перевод: ошибка поллинга\n' + e, '#e53935'); log('poll ERR ' + e); });
    }, delay);
  }

  function muteVideo() {
    var v = findVideo();
    if (!v) return;
    try { v.muted = true; } catch (e) { }
    try { v.volume = 0; } catch (e) { }
  }

  // The translated track always starts at 0:00, so on the first successful
  // start we rewind the page video too — otherwise the picture is as far ahead
  // as the translation took to prepare (a minute or more).
  function restartVideo(cb) {
    var v = findVideo();
    if (!v) { cb(); return; }
    if (state.restarting) { setTimeout(cb, 500); return; }
    state.restarting = true;
    var startPos = Number(v.currentTime) || 0;
    log('restart video from ' + startPos.toFixed(1) + 's');
    try { v.currentTime = 0; } catch (e) { log('restart seek ERR ' + e); }
    var t0 = Date.now();
    var bumps = 0;
    (function verify() {
      var vv = findVideo();
      if (!vv) { state.restarting = false; cb(); return; }
      var cur = Number(vv.currentTime) || 0;
      if (vv.paused) {
        try {
          var pr = vv.play();
          if (pr && pr.catch) pr.catch(function () { });
        } catch (e) { }
      }
      if (cur <= 1.5) {
        state.restarting = false;
        log('restart ok at ' + cur.toFixed(1) + 's');
        cb();
        return;
      }
      if (Date.now() - t0 > RESTART_MAX_WAIT) {
        // The page player refused to rewind (or is still buffering): play from
        // wherever it is instead of leaving the user without translation.
        state.restarting = false;
        log('restart gave up at ' + cur.toFixed(1) + 's');
        cb();
        return;
      }
      // The TV player sometimes snaps back to its own position once; nudge it.
      if (bumps === 3 || bumps === 8) {
        bumps++;
        try { vv.currentTime = 0; } catch (e) { }
      } else {
        bumps++;
      }
      setTimeout(verify, 250);
    })();
  }

  // Start or re-point the bridge player at `url`, keeping the video position.
  function beginPlayback(url, done) {
    // Ролик стоит на паузе: перевод не должен звучать сам по себе. Запоминаем
    // ссылку и стартуем ровно в момент, когда пользователь включит ролик.
    var v0 = findVideo();
    if (v0 && v0.paused) {
      state.pendingPlay = url;
      state.busy = false;
      log('play deferred (video paused) ' + String(url).slice(0, 40));
      setStatus('Перевод: готов, включится вместе с роликом', '#90a4ae');
      schedulePaint();
      return;
    }
    state.pendingPlay = null;
    muteVideo();
    if (!state.playedOnce) {
      restartVideo(function () { startBridgePlayer(url, done); });
      return;
    }
    startBridgePlayer(url, done);
  }

  function startBridgePlayer(url, done) {
    var offset = currentVideoTime();
    http('POST', '/play', { url: url, offsetSec: offset }, function () {
      state.curUrl = url;
      state.active = true;
      state.audioPaused = false;
      state.lastSeek = 0;
      state.busy = false;
      state.playedOnce = true;
      log('play offset=' + offset.toFixed(1));
      // Перевод пошёл — сразу применяем ЕГО громкость: иначе играет 100%,
      // пока пользователь не тронет ползунок заново.
      applyVolume();
      if (!state.loop) { state.loop = true; syncLoop(); }
      if (done) done();
    }, function (e) {
      state.busy = false;
      setStatus('Перевод: не запустился плеер\n' + e, '#e53935');
      log('play ERR ' + e);
    });
  }

  // Перевод готов, но язык оригинала ещё не известен. Раньше звук стартовал
  // сразу, и русский ролик, у которого уже был готовый перевод в кэше Яндекса,
  // успевал заиграть переводом на несколько секунд — пока с ПК не приезжал язык
  // и «исключённый язык» не гасил звук. Теперь держим запуск, пока язык не
  // придёт (быстрый детектор на ПК ~0.4-1 с), но не дольше LANG_GATE_MS:
  // оригинал при этом продолжает играть, паузы нет.
  function gateReady(id, url, partial) {
    var skip = langBase(uiPref('skipLang', 'ru'));
    // Правило выключено или язык уже известен — обычный путь без задержки.
    if (!skip || state.origLang || state.forceTranslate === id) {
      if (partial) onPartial(url); else onReady(url);
      return;
    }
    var gateMs = Number((state.cfg && state.cfg.langGateMs) || LANG_GATE_MS);
    if (!(gateMs > 0)) gateMs = LANG_GATE_MS;
    state.gate = { id: id, url: url, partial: !!partial, until: Date.now() + gateMs };
    setStatus('Перевод: готов, проверяю язык ролика…', '#f5a623', 'wait');
    log('lang gate wait id=' + id + ' url=' + String(url).slice(0, 40) +
      ' max=' + Math.round(gateMs) + 'ms');

    function deliver(g) {
      state.gate = null;
      if (state.curId !== id) return;
      if (g.partial) onPartial(g.url); else onReady(g.url);
    }

    function tick() {
      var g = state.gate;
      if (!g || g.id !== id) return; // гейт снят (новый ролик/новый ответ)
      if (state.curId !== id) { state.gate = null; return; }
      if (state.skipLangBlock === id) {
        state.gate = null;
        log('lang gate: lang excluded -> no audio');
        return;
      }
      if (state.offForId === id || uiPref('translate.enabled', true) === false) {
        state.gate = null;
        log('lang gate: translate disabled -> drop');
        return;
      }
      if (state.origLang) {
        log('lang gate: lang=' + state.origLang + ' -> play');
        deliver(g);
        return;
      }
      if (Date.now() >= g.until) {
        log('lang gate: lang unknown -> start anyway');
        deliver(g);
        return;
      }
      setTimeout(tick, 200);
    }

    setTimeout(tick, 200);
  }

  function onPartial(url) {
    if (state.curUrl === url) return;
    state.partial = true;
    if (state.active) {
      log('partial swap ' + String(url).slice(0, 40));
      beginPlayback(url, null);
      return;
    }
    log('partial play ' + String(url).slice(0, 40));
    setStatus('Перевод: играю (хвост ещё переводится)', '#4caf50');
    beginPlayback(url, null);
  }

  function onReady(url) {
    if (state.curUrl === url) {
      state.busy = false;
      setStatus('Перевод: ГОТОВО — играю', '#4caf50');
      return;
    }
    log('play ' + String(url).slice(0, 48));
    setStatus(state.livelyVoice ? 'Перевод: ГОТОВО (живой голос) — играю'
      : (state.partial ? 'Перевод: ГОТОВО — обновляю на полный' : 'Перевод: ГОТОВО — играю'), '#4caf50');
    state.partial = false;
    beginPlayback(url, null);
  }

  // Stop the bridge player (used on pause/ended/leave) and forget the session.
  function stopAudio(clearTranslation) {
    // Гейт держит готовый перевод до прихода языка: если звука ещё нет
    // (state.active=false), ранний return ниже не должен оставлять его живым.
    if (clearTranslation) state.gate = null;
    if (!state.active && !state.audioPaused) return;
    state.active = false;
    state.audioPaused = false;
    state.loop = false;
    state.partial = false;
    state.curUrl = null;
    state.lastSeek = 0;
    // Вернулись к оригиналу — вернуть его громкость.
    applyVolume();
    if (clearTranslation) {
      state.translationId = null;
      state.audioUploaded = false;
      state.uploading = false;
    }
    http('POST', '/stop', { }, function () { }, function () { });
  }

  function syncLoop() {
    if (!state.active) { state.loop = false; return; }
    state.loop = true;
    var v = findVideo();
    var hidden = false;
    try { hidden = !!document.hidden; } catch (e) { }
    var pageGone = !v || !document.body || !document.body.contains(v);

    if (pageGone || hidden || v.ended) {
      // Video is gone, finished or the app is in background: no reason to
      // keep the translated audio playing. The player is kept around so a
      // later resume does not have to re-download anything.
      if (!state.audioPaused) {
        log('sync pause reason=' + (pageGone ? 'no-video' : (hidden ? 'hidden' : 'ended')));
        state.audioPaused = true;
        http('POST', '/pause', { }, function () { }, function () { });
      }
      if (pageGone) { state.gate = null; stopAudio(false); return; }
      setTimeout(syncLoop, SYNC_INTERVAL);
      return;
    }

    if (v.paused) {
      if (!state.audioPaused) {
        log('sync pause reason=paused');
        state.audioPaused = true;
        http('POST', '/pause', { }, function () { }, function () { });
      }
      setTimeout(syncLoop, SYNC_INTERVAL);
      return;
    }

    if (state.audioPaused) {
      log('sync resume');
      state.audioPaused = false;
      http('POST', '/resume', { }, function () { }, function () { });
    }

    http('GET', '/position', null, function (p) {
      if (!state.active) return;
      var vv = currentVideoTime();
      var av = (Number(p.positionMs) || 0) / 1000;
      // While the player is still buffering its position is meaningless and
      // seeking it would only produce another stutter.
      if (p.prepared === false) { setTimeout(syncLoop, SYNC_INTERVAL); return; }
      if (av >= 0 && Math.abs(av - vv) > SYNC_THRESHOLD) {
        var now = Date.now();
        if (now - state.lastSeek > SEEK_COOLDOWN) {
          state.lastSeek = now;
          log('resync av=' + av.toFixed(1) + ' vv=' + vv.toFixed(1));
          http('POST', '/seek', { offsetSec: vv }, function () { }, function () { });
        }
      }
      setTimeout(syncLoop, SYNC_INTERVAL);
    }, function () { setTimeout(syncLoop, 2000); });
  }

  // ---- boot -----------------------------------------------------------
  log(MARK + ' loaded href=' + String(location.href).slice(0, 110));

  http('GET', '/ping', null, function (r) {
    log('bridge reachable: ' + JSON.stringify(r));
    // Live voices / worker settings live in the bridge (vot_config.json).
    http('GET', '/config', null, function (c) {
      state.cfg = c || {};
      if (c && typeof c.lang === 'string' && c.lang) state.lang = c.lang;
      log('config lively=' + c.lively + ' token=' + (c.hasToken ? 'yes' : 'no') +
        ' worker=' + (c.worker || '-') + ' proxy=' + (c.proxyMode || 'off') +
        ' audio=' + (c.audioMode || 'off') + ' pcFill=' + (c.pcFill === false ? 0 : 1) +
        ' lang=' + state.lang);
    }, function (e) { log('config ERR ' + e); });
  }, function (e) {
    setStatus('Перевод: мост недоступен\n' + e, '#e53935');
    log('bridge NOT reachable: ' + e);
  });

  // ---- watch page watcher ----------------------------------------------
  setInterval(function () {
    var id = getVideoId();
    if (!id) {
      // Left the watch page: kill the translated audio and reset session state.
      if (state.curId !== null) {
        log('watch left -> stop');
        stopAudio(true);
        state.curId = null;
        state.busy = false;
        state.wantOn = null;
        setStatus('Перевод: ожидание видео…', '#90a4ae');
      }
      return;
    }
    if (id === state.curId) return;
    state.curId = id;
    state.busy = false;
    state.active = false;
    state.audioPaused = false;
    // Язык оригинала относится к конкретному ролику: без сброса предыдущее
    // значение (например ru) применится к новому видео и оно будет пропущено.
    state.origLang = '';
    state.skipLangBlock = null;
    state.forceTranslate = null;
    state.offForId = null;
    state.wantOn = null;
    state.pendingPlay = null;
    state.gate = null;
    state.loop = false;
    state.partial = false;
    state.curUrl = null;
    state.translationId = null;
    state.altLangTried = false;
    state.audioTried = false;
    state.audioUploaded = false;
    state.audioIdx = 0;
    state.uploading = false;
    state.retried = false;
    state.pcTried = false;
    state.pcDeadline = 0;
    state.pcFailed = false;
    state.pcDone = false;
    state.pcWaits = 0;
    state.pcExtends = 0;
    state.capTried = false;
    state.capBusy = false;
    state.capFailed = false;
    state.capTries = 0;
    state.capSentSize = 0;
    state.sixSince = 0;
    state.sixWaits = 0;
    state.polls = 0;
    state.livelyVoice = false;
    state.playedOnce = false;
    state.restarting = false;
    state.lastSeek = 0;
    http('POST', '/stop', { }, function () { }, function () { });
    setStatus('Перевод: видео найдено, жду плеер…\nvideo=' + id, '#90a4ae');
    log('watch detected id=' + id);
    // Ряд кнопок перерисовывается под новый ролик: подсветку ставим сразу,
    // не дожидаясь тика (иначе кнопка на секунду гаснет).
    try { schedulePaint(); } catch (ep) { }
    fetchMeta(id);
    var tries = 0;
    (function wait() {
      var v = findVideo();
      if (v && v.duration > 0) {
        log('video ready id=' + id + ' dur=' + v.duration.toFixed(1) + ' src=' + String(v.currentSrc || v.src || '').slice(0, 180));
        gvProbes();
        probeYttv();
        probeYtcfg();
        probeAudio();
        probeLang();
        startTranslation(id, v.duration);
      } else if (tries++ < 60) {
        setTimeout(wait, 1000);
      } else {
        setStatus('Перевод: нет <video> элемента\nvideo=' + id, '#e53935');
        log('no video element for id=' + id);
        state.curId = null;
      }
    })();
  }, 1500);

  // ===== VOT-UI BEGIN: панель настроек перевода (рендерит vot_ui.js) =====
  function uiPref(k, d) {
    try { return window.VOTUI ? VOTUI.pref(k, d) : d; } catch (e) { return d; }
  }
  function uiSet(k, v) {
    try { if (window.VOTUI) VOTUI.setPref(k, v); return; } catch (e) { }
    try { localStorage.setItem('vot-ui-' + k, JSON.stringify(v)); } catch (e2) { }
  }
  function uiToast(m, ms) {
    try { if (window.VOTUI) VOTUI.toast(m, ms); } catch (e) { }
  }

  // Громкость перевода живёт ВНЕ страницы: звук играет нативный MediaPlayer
  // внутри моста, поэтому из JS его не приглушить — уровень уходит запросом
  // /volume (Bridge.java), а мост хранит его в sVol и ставит новым плеерам.
  // В видео остаётся звук оригинала: при работающем переводе его уровень задаёт
  // «Оригинал при переводе», без перевода видео всегда 100 % (иначе пункт меню
  // глушил бы обычный просмотр).
  var volSentTr = -1; // последний уровень перевода, отправленный в мост

  function volPct(k, def) {
    var n = Math.round(Number(uiPref(k, def)));
    if (!isFinite(n)) n = def;
    return Math.max(0, Math.min(100, n));
  }

  function applyVolume() {
    var tr = volPct('vol.translate', 100);
    if (tr !== volSentTr) {
      volSentTr = tr;
      http('POST', '/volume', { pct: tr }, function () { }, function (e) {
        log('vol ERR ' + (e && e.message));
      });
    }
    var v = findVideo();
    if (!v) return;
    var pct = state.active ? volPct('vol.original', 0) : 100;
    try { v.muted = (pct <= 0); } catch (e1) { }
    try { v.volume = Math.max(0, Math.min(1, pct / 100)); } catch (e2) { }
    // Cobalt может игнорировать v.volume (звук идёт мимо WebAudio), поэтому
    // логируем и запрошенное, и фактическое значение — иначе не отличить
    // «ползунок не работает» от «громкость применяется на стороне плеера».
    var got = 1;
    try { got = v.volume; } catch (e3) { got = -1; }
    log('vol tr=' + tr + ' orig=' + pct + ' active=' + (state.active ? 1 : 0)
      + ' muted=' + (v.muted ? 1 : 0) + ' got=' + got);
  }

  // Подпись пункта «Громкость» в корне нативной панели.
  function votVolText() {
    return 'перевод ' + volPct('vol.translate', 100) + '% · оригинал ' + volPct('vol.original', 0) + '%';
  }

  var VOT_LANGS = [
    { label: 'не выбрано', value: '' },
    { label: 'русский', value: 'ru' },
    { label: 'английский', value: 'en' },
    { label: 'украинский', value: 'uk' },
    { label: 'казахский', value: 'kk' },
    { label: 'немецкий', value: 'de' },
    { label: 'французский', value: 'fr' },
    { label: 'испанский', value: 'es' }
  ];

  function langLabel(code) {
    for (var i = 0; i < VOT_LANGS.length; i++) {
      if (String(VOT_LANGS[i].value) === String(code)) return VOT_LANGS[i].label;
    }
    return String(code || '') || 'не выбрано';
  }

  // «ru-RU», «RU», «ru» — один язык: Яндекс и yt-dlp отдают тег с регионом, а в
  // настройках лежит двухбуквенный код. Без нормализации сравнение промахивалось
  // и русский ролик уезжал в перевод (замечание ревью).
  function langBase(code) {
    return String(code || '').toLowerCase().split('-')[0];
  }

  // Базовый URL ПК-сервера: мост на ТВ (/fill_status и др.) проксирует только
  // фиксированные пути, поэтому /meta спрашиваем у ПК напрямую.
  var PC_BASE = 'http://192.168.1.186:8013';

  function httpPC(method, path, body, cb, err) {
    try {
      var x = new XMLHttpRequest();
      x.open(method, PC_BASE + path, true);
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status === 200) {
          try { cb(JSON.parse(x.responseText)); } catch (e) { (err || function () { })(e); }
        } else {
          (err || function () { })(new Error('http ' + x.status + ' ' + String(x.responseText || '').slice(0, 160)));
        }
      };
      x.onerror = function () { (err || function () { })(new Error('network')); };
      x.send(body ? JSON.stringify(body) : null);
    } catch (e) { (err || function () { })(e); }
  }

  // Ролик оказался на исключённом языке (по умолчанию русский) уже после старта
  // перевода: гасим звук перевода и блокируем повторный запуск для этого id.
  function maybeSkipNow(id, lang) {
    var skip = langBase(uiPref('skipLang', 'ru'));
    if (!skip || langBase(lang) !== skip) return;
    if (state.skipLangBlock === id) return;
    state.skipLangBlock = id;
    var wasRunning = state.active || state.audioPaused || state.busy;
    log((wasRunning ? 'translate abort: source lang=' : 'translate skip (late meta): source lang=')
      + lang + ' matches skipLang=' + skip + ' id=' + id);
    state.busy = false;
    state.pendingPlay = null;
    state.gate = null;
    if (wasRunning) stopAudio(true);
    setStatus('Перевод: ролик на языке «' + langLabel(lang) + '»\n(исключён в настройках)', '#90a4ae');
    schedulePaint();
  }

  // Язык оригинала: на ТВ-сборке ytInitialPlayerResponse нет, поэтому язык
  // спрашиваем у ПК; нужен для правила «не переводить с языка» и для гейта
  // запуска звука (gateReady). Прямой запрос к ПК (http://192.168.1.186) из
  // HTTPS-страницы блокируется как mixed content, поэтому идём через мост:
  // /fill_status он уже проксирует на ПК, а ПК дописывает в ответ lang/title
  // (быстрый детектор /youtubei/v1/player ~0.4-1 с, yt-dlp — фолбэк).
  // Пока ПК не успел — повторяем опрос по META_GAPS.
  // Serverless: язык оригинала спрашивает мост (/meta_local = порт yt_lang.py).
  // Если мост не смог — тихо откатываемся на прежний путь через ПК.
  // Serverless-приоритет: когда ПК-филлер выключен (pcFill:false) или мост работает
  // в режиме local, язык спрашиваем у моста (/meta_local, порт player-ответа). Путь
  // через ПК (/fill_status) при выключенном ПК — это до 10 запросов по META_GAPS
  // (~17 с) на каждый ролик и гарантированный таймаут. Фолбэк на ПК оставляем
  // только если pcFill явно разрешён.
  function fetchMeta(id, tries) {
    var n = tries || 0;
    var cfg = state.cfg || {};
    var pcOk = cfg.pcFill === true;
    if (cfg.audioMode === 'local' || !pcOk) { fetchMetaLocal(id, n, pcOk); return; }
    fetchMetaPC(id, n);
  }

  function fetchMetaLocal(id, n, pcFallback) {
    http('GET', '/meta_local?videoId=' + encodeURIComponent(id), null, function (j) {
      if (state.curId !== id) return;
      var lang = String((j && j.lang) || '');
      if (j && j.ok && lang) {
        if (lang !== state.origLang) {
          state.origLang = lang;
          log('meta_local id=' + id + ' lang=' + lang + ' ms=' + (j.ms || 0)
            + ' title=' + String(j.title || '').slice(0, 40));
          maybeSkipNow(id, lang);
        }
        return;
      }
      // Без ПК повторять бессмысленно: язык доберём из ответа Яндекса (поле 8)
      // в maybeSkipNow, а перевод всё равно стартует (source lang unknown).
      if (!pcFallback) {
        log('meta_local fail ' + String((j && j.err) || 'no lang') + ' (serverless, no pc meta)');
        return;
      }
      log('meta_local fail ' + String((j && j.err) || 'no lang') + ' -> pc meta');
      fetchMetaPC(id, n);
    }, function (e) {
      if (state.curId !== id) return;
      if (!pcFallback) {
        log('meta_local ERR ' + (e && e.message) + ' (serverless, no pc meta)');
        return;
      }
      log('meta_local ERR ' + (e && e.message) + ' -> pc meta');
      fetchMetaPC(id, n);
    });
  }

  function fetchMetaPC(id, tries) {
    var n = tries || 0;
    http('GET', '/fill_status?videoId=' + encodeURIComponent(id), null, function (j) {
      if (state.curId !== id) return;
      var lang = String((j && j.lang) || '');
      if (lang) {
        if (lang !== state.origLang) {
          state.origLang = lang;
          log('meta id=' + id + ' lang=' + lang
            + ' title=' + String((j && j.title) || '').slice(0, 40));
          maybeSkipNow(id, lang);
        }
        return;
      }
      if (n < META_GAPS.length) {
        setTimeout(function () { fetchMetaPC(id, n + 1); }, META_GAPS[n]);
      } else {
        log('meta id=' + id + ' lang unknown (pc meta timeout)');
      }
    }, function (e) {
      // Сетевая ошибка (ПК перезапускается) — это не «языка нет»: повторяем,
      // иначе ролик навсегда останется без определения языка.
      if (state.curId !== id) return;
      log('meta ERR ' + (e && e.message) + ' try=' + (n + 1));
      if (n < META_GAPS.length) {
        setTimeout(function () { fetchMetaPC(id, n + 1); }, META_GAPS[n]);
      }
    });
  }

  function manualFill() {
    var v = findVideo(), id = state.curId;
    if (!id) { uiToast('Нет активного ролика'); return; }
    uiToast('ПК заполняет звук…');
    pcFill(id, (v && v.duration) ? v.duration : 0, { translationId: state.translationId }, 'manual');
  }

  function checkFillStatus() {
    var id = state.curId;
    if (!id) { uiToast('Нет активного ролика'); return; }
    http('GET', '/fill_status?videoId=' + encodeURIComponent(id), null, function (j) {
      // 'none' is not a failure: the PC keeps jobs in memory only, and a job
      // exists solely after POST /fill for this very videoId. Say that plainly.
      var st = String((j && j.state) || '');
      var text;
      if (st === 'run') {
        text = 'ПК: качает и синтезирует…';
      } else if (st === 'ok') {
        text = 'ПК: готово';
      } else if (st === 'err') {
        var why = String((j && (j.error || j.why)) || '');
        text = 'ПК: не смог' + (why ? ' — ' + why.slice(0, 70) : '');
      } else if (st === 'offline') {
        text = 'ПК: недоступен';
      } else {
        text = 'ПК: этот ролик не отправляли';
      }
      if (j && j.status) { text += ' · status=' + j.status; }
      uiToast(text);
    }, function (e) { uiToast('ПК недоступен: ' + (e && e.message)); });
  }

  function openTranslatePanel() {
    if (!window.VOTUI || !VOTUI.open) { uiToast('UI-слой не загружен'); return; }
    var items = [
      { title: 'Перевод включён', type: 'toggle',
        value: function () { return uiPref('translate.enabled', true) !== false; },
        // Тот же выключатель, что и кнопка в баре: выключение останавливает
        // звук и запрещает автоперевод следующих роликов.
        onSelect: function () { toggleTranslate(); } },
      { title: 'Шард запроса', type: 'choice',
        value: function () { return String(uiPref('shard', 'auto')); },
        options: function () { return [{ label: 'auto (как на ТВ)', value: 'auto' }, { label: 'en', value: 'en' }]; },
        onPick: function (v) { uiSet('shard', v); state.lang = v; } },
      { title: 'Искать в другом кэше', type: 'toggle',
        value: function () { return uiPref('otherShard.enabled', true) !== false; },
        onSelect: function () { uiSet('otherShard.enabled', uiPref('otherShard.enabled', true) === false); } },
      { title: 'ПК-филлер', type: 'toggle',
        value: function () { return uiPref('pcFill.enabled', true) !== false; },
        onSelect: function () { uiSet('pcFill.enabled', uiPref('pcFill.enabled', true) === false); } },
      { title: 'Громкость перевода', type: 'slider', min: 0, max: 100, step: 5,
        value: function () { return volPct('vol.translate', 100); },
        format: function (v) { return v + '%'; },
        onChange: function (v) { uiSet('vol.translate', v); applyVolume(); } },
      { title: 'Оригинал при переводе', type: 'slider', min: 0, max: 100, step: 5,
        value: function () { return volPct('vol.original', 0); },
        format: function (v) { return v + '%'; },
        onChange: function (v) { uiSet('vol.original', v); applyVolume(); } },
      { title: 'Не переводить с языка (по умолч. рус.)', type: 'choice',
        value: function () { return langLabel(uiPref('skipLang', 'ru')); },
        options: function () { return VOT_LANGS; },
        onPick: function (v) {
          uiSet('skipLang', v);
          // Пользователь поменял правило: снимаем блокировку с текущего ролика.
          state.skipLangBlock = null;
        } },
      { title: 'Заполнить звук на ПК сейчас', type: 'action', onSelect: manualFill },
      { title: 'Проверить статус ПК', type: 'action', onSelect: checkFillStatus },
      { title: 'Статус перевода', type: 'info', value: function () { return state.uiStatus || ''; } }
    ];
    VOTUI.open({
      title: 'Перевод Яндекс',
      subtitle: state.curId ? ('ролик ' + state.curId + (state.lang ? ' · шард ' + state.lang : '')) : 'ролик не открыт',
      items: items
    });
  }

  // ---- нативное меню «Перевод» (многоуровневое, как «Аудио»/«Качество») -----
  // Клиент рисует панель по данным из САМОЙ команды
  // (openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer…)
  // и исполняет её, только если она вложена в serviceEndpoint пункта — ровно так
  // открываются «Качество»/«Субтитры». Пересылка готовой команды через
  // диспетчер из JS клиентом игнорируется (проверено на ТВ), поэтому наши
  // уровни вкладываются в пункты при сборке попапа: шаблон — команда корня
  // настроек (votTpl, снимается в popupInsert), пункты — свои, uid = vot-*.
  var votTpl = null;    // команда корня настроек — шаблон для наших плашек
  var votBuildDepth = 0; // защита от рекурсии при сборке уровней
  var instSeq = 0, popupInstLog = 0;
  var votSetLog = 0;

  function isObj(o) { return !!o && typeof o === 'object'; }

  function shallowCopy(o) {
    var r = {}, k;
    if (!isObj(o)) return r;
    for (k in o) { try { r[k] = o[k]; } catch (e) { } }
    return r;
  }

  // Копируем звенья пути до items и подменяем список — исходную команду
  // (её переиспользует клиент) менять нельзя.
  function votCloneCmd(src, items, uid) {
    if (!src || !src.openPopupAction) return null;
    var oa = shallowCopy(src.openPopupAction), pop = shallowCopy(oa.popup);
    var sec = shallowCopy(pop.overlaySectionRenderer), ov = shallowCopy(sec.overlay);
    var tp = shallowCopy(ov.overlayTwoPanelRenderer), ap = shallowCopy(tp.actionPanel);
    var pan = shallowCopy(ap.overlayPanelRenderer), ct = shallowCopy(pan.content);
    var lst = shallowCopy(ct.overlayPanelItemListRenderer);
    lst.items = items;
    ct.overlayPanelItemListRenderer = lst;
    pan.content = ct; ap.overlayPanelRenderer = pan; tp.actionPanel = ap;
    ov.overlayTwoPanelRenderer = tp; sec.overlay = ov; pop.overlaySectionRenderer = sec;
    oa.popup = pop;
    if (uid) oa.uniqueId = uid;
    var cmd = shallowCopy(src);
    cmd.openPopupAction = oa;
    cmd.__votOwn = 1; // свою панель не патчим пунктом «Перевод»
    return cmd;
  }

  function votEndp(action) {
    return { commandExecutorCommand: { commands: [{ customAction: { action: action } }] } };
  }

  function votItem(o) {
    var lr = { title: { simpleText: o.title } };
    if (o.sub) lr.subtitle = { simpleText: String(o.sub) };
    if (o.icon) lr.icon = { iconType: o.icon };
    if (o.second) lr.secondaryIcon = { iconType: o.second };
    if (o.action) lr.serviceEndpoint = votEndp(o.action);
    return { compactLinkRenderer: lr };
  }

  function votChevron(title, sub, action, icon) {
    return votItem({ title: title, sub: sub, icon: icon, second: 'CHEVRON_RIGHT', action: action });
  }

  function votCheck(title, key, val, sel, sub) {
    return votItem({ title: title, sub: sub,
      second: sel ? 'CHECK' : 'RADIO_BUTTON_UNCHECKED',
      action: 'VOT_SET:' + key + ':' + val });
  }

  function votSwitch(title, sub, key, on) {
    return votCheck(title, key, on ? '0' : '1', on, sub);
  }

  // Пункт-стрелка, который открывает НАШУ стопку плашек: подпанель вкладывается
  // прямо в serviceEndpoint пункта — тем же путём клиент открывает «Качество» и
  // «Субтитры» (никакой пересылки команд из JS: её клиент игнорирует).
  function votNavItem(title, sub, lv, icon) {
    var cmd = votPanelCmd(lv);
    var lr = { title: { simpleText: title } };
    if (sub) lr.subtitle = { simpleText: String(sub) };
    if (icon) lr.icon = { iconType: icon };
    lr.secondaryIcon = { iconType: 'CHEVRON_RIGHT' };
    lr.serviceEndpoint = cmd
      ? { commandExecutorCommand: { commands: [cmd] } }
      : votEndp('VOT_NAV:' + lv); // шаблона ещё нет — откроем DOM-панель
    return { compactLinkRenderer: lr };
  }

  // Команда нашей панели: копия корня настроек с нашими пунктами и своим uid.
  function votPanelCmd(lv) {
    if (!votTpl || votBuildDepth > 2) return null;
    var items = null;
    votBuildDepth++;
    try { items = votLevelItems(lv); } catch (e) {
      log('vot items ERR ' + (e && e.message));
      items = null;
    }
    votBuildDepth--;
    if (!items) return null;
    return votCloneCmd(votTpl, items, lv);
  }

  function votSrcText() {
    var o = uiPref('otherShard.enabled', true) !== false;
    var p = uiPref('pcFill.enabled', true) !== false;
    return (o ? 'другой кэш' : 'только шард') + (p ? ' + ПК' : '');
  }

  function votStatusText() {
    var s = String(state.uiStatus || '');
    if (!s) s = state.curId ? ('ролик ' + state.curId) : 'ролик не открыт';
    return s.slice(0, 70);
  }

  function votLevelItems(lv) {
    var on = uiPref('translate.enabled', true) !== false && isTranslateOn(), i, out = [];
    if (lv === 'vot-src') {
      out.push(votSwitch('Другой шард кэша', 'искать озвучку в соседнем кэше',
        'otherShard.enabled', uiPref('otherShard.enabled', true) !== false));
      out.push(votSwitch('ПК-филлер', 'дозаполнять звук через ПК',
        'pcFill.enabled', uiPref('pcFill.enabled', true) !== false));
      out.push(votItem({ title: 'Заполнить звук сейчас', sub: 'через ПК', action: 'VOT_FILL' }));
      out.push(votItem({ title: 'Проверить статус ПК', action: 'VOT_FILLSTATUS' }));
      return out;
    }
    if (lv === 'vot-shard') {
      out.push(votCheck('auto (как на ТВ)', 'shard', 'auto', String(uiPref('shard', 'auto')) === 'auto'));
      out.push(votCheck('en', 'shard', 'en', String(uiPref('shard', 'auto')) === 'en'));
      return out;
    }
    if (lv === 'vot-vol') {
      // Родного слайдера в клиенте нет, поэтому строка ведёт себя как ползунок:
      // влево/вправо меняют уровень шагом 10 % (votSliderKeys), значение
      // применяется сразу и сразу же перерисовывается в этой строке.
      out.push(votItem({ title: 'Громкость перевода',
        sub: volPct('vol.translate', 100) + '% · влево/вправо',
        icon: 'VOLUME_UP', second: 'CHEVRON_LEFT' }));
      out.push(votItem({ title: 'Оригинал при переводе',
        sub: volPct('vol.original', 0) + '% · влево/вправо',
        icon: 'VOLUME_MUTE', second: 'CHEVRON_LEFT' }));
      return out;
    }
    if (lv === 'vot-skip') {
      var sk = String(uiPref('skipLang', 'ru') || '');
      for (i = 0; i < VOT_LANGS.length; i++) {
        out.push(votCheck(VOT_LANGS[i].label, 'skipLang', String(VOT_LANGS[i].value),
          sk === String(VOT_LANGS[i].value)));
      }
      return out;
    }
    // корень
    out.push(votItem({ title: 'Перевод Яндекс', sub: on ? 'включён' : 'выключен',
      icon: 'TRANSLATE', second: on ? 'CHECK' : 'RADIO_BUTTON_UNCHECKED',
      action: VOT_TOGGLE_ACTION }));
    out.push(votNavItem('Источник перевода', votSrcText(), 'vot-src'));
    out.push(votNavItem('Шард запроса', String(uiPref('shard', 'auto')), 'vot-shard'));
    out.push(votNavItem('Громкость', votVolText(), 'vot-vol'));
    out.push(votNavItem('Не переводить с', langLabel(uiPref('skipLang', 'ru')), 'vot-skip'));
    out.push(votItem({ title: 'Статус', sub: votStatusText() }));
    return out;
  }

  function votSet(rest) {
    var s = String(rest || ''), p = s.indexOf(':');
    if (p < 0) { log('vot set: bad ' + s.slice(0, 24)); return; }
    var k = s.slice(0, p), v = s.slice(p + 1);
    if (k === 'shard') { uiSet('shard', v); state.lang = v; }
    else if (k === 'otherShard.enabled' || k === 'pcFill.enabled') uiSet(k, v === '1');
    else if (k === 'vol.translate' || k === 'vol.original') { uiSet(k, Number(v) || 0); applyVolume(); }
    else if (k === 'skipLang') { uiSet('skipLang', v); state.skipLangBlock = null; }
    else { log('vot set: unknown ' + k); return; }
    if (votSetLog < 24) { votSetLog++; log('vot set ' + k + '=' + v); }
    // Нативная панель закрывается на выборе (как «Качество»), поэтому ничего не
    // перерисовываем: подписи уровней обновятся при следующем открытии меню.
  }

  // Единая точка разбора наших действий: и кнопка в баре, и пункты панели
  // приходят сюда через перехваченный resolveCommand.
  function handleAction(a) {
    var s = String(a || '');
    if (!s) return false;
    if (s === VOT_TOGGLE_ACTION) { log('btn TOGGLE'); toggleTranslate(); return true; }
    // VOT_ACTION/VOT_NAV остаются только как страховка: их шлют пункты,
    // собранные до того, как мы поймали шаблон нативной панели.
    if (s === VOT_ACTION) { log('btn PRESSED'); openTranslatePanel(); return true; }
    if (s.indexOf('VOT_NAV:') === 0) { openTranslatePanel(); return true; }
    if (s.indexOf('VOT_SET:') === 0) { votSet(s.slice(8)); return true; }
    if (s === 'VOT_FILL') { manualFill(); return true; }
    if (s === 'VOT_FILLSTATUS') { checkFillStatus(); return true; }
    return false;
  }

  // Ползунки громкости. Родного слайдера в ТВ-клиенте нет (в реестре только
  // compactLinkRenderer/setting*-рендереры), поэтому влево/вправо ловим сами:
  // срабатывает, только когда фокус стоит на строке «Громкость перевода» или
  // «Оригинал при переводе» — в остальных плашках стрелки работают как обычно.
  // Клиент рисует подписи из нашей команды ровно один раз, поэтому после
  // изменения уровня строку приходится перерисовывать вручную (votPaintValue).
  var volKeyLog = 0;

  // Какая из наших строк в фокусе. Подпись может лежать в aria-label (как у
  // кнопок плеера) или текстом в поддереве — проверяем и то, и другое.
  function volKeyOf(a) {
    if (!a) return '';
    var al = '', tx = '';
    try { if (a.getAttribute) al = String(a.getAttribute('aria-label') || ''); } catch (e) { }
    try { tx = String(a.textContent || ''); } catch (e2) { }
    var s = (al + ' ' + tx).replace(/\s+/g, ' ').toLowerCase();
    if (s.indexOf('громкость перевода') >= 0) return 'vol.translate';
    if (s.indexOf('оригинал при переводе') >= 0) return 'vol.original';
    return '';
  }

  // Подмена значения прямо в узле строки: «… 70% · влево/вправо».
  function votPaintValue(node, val) {
    if (!node) return 0;
    var re = /(\d{1,3})(\s*%)/, hit = 0, arr = [node], kids = [], i, j;
    try { kids = node.getElementsByTagName ? node.getElementsByTagName('*') : []; } catch (e) { kids = []; }
    for (i = 0; i < kids.length; i++) arr.push(kids[i]);
    for (i = 0; i < arr.length; i++) {
      var el = arr[i], ch = null, attrs = ['aria-label', 'title'];
      try { ch = el.childNodes; } catch (e2) { ch = null; }
      if (ch) {
        for (j = 0; j < ch.length; j++) {
          var n = ch[j];
          if (!hit && n && n.nodeType === 3 && re.test(String(n.nodeValue || ''))) {
            n.nodeValue = String(n.nodeValue).replace(re, String(val) + '$2');
            hit = 1;
          }
        }
      }
      for (j = 0; j < attrs.length; j++) {
        try {
          var av = el.getAttribute && el.getAttribute(attrs[j]);
          if (av && re.test(String(av))) {
            el.setAttribute(attrs[j], String(av).replace(re, String(val) + '$2'));
          }
        } catch (e3) { }
      }
    }
    return hit;
  }

  // Строка «Громкость перевода», на которой остался фокус, может НЕ быть видна:
  // нативная панель закрылась, а её DOM (с нашими подписями) остался в дереве и
  // продолжает держать activeElement. Раньше в этом случае мы всё равно гасили
  // LEFT/RIGHT (preventDefault + stopPropagation), и клиент переставал получать
  // стрелки — интерфейс плеера «пропадал» до перезапуска приложения. Поэтому
  // перехватываем клавиши только если строка реально на экране: проверяем сам
  // узел и трёх его предков (глубже обход на ТВ дорог).
  var volIgn = 0;
  function nodeOnScreen(a) {
    if (!a || a.nodeType !== 1 || !a.getBoundingClientRect) return false;
    try {
      if (!document.body || !document.body.contains(a)) return false;
      var r = a.getBoundingClientRect();
      if (!r || r.width < 4 || r.height < 4) return false;
      var cur = a, i, st = null;
      for (i = 0; i < 4 && cur && cur.nodeType === 1; i++) {
        try {
          st = window.getComputedStyle ? window.getComputedStyle(cur) : null;
          if (st) {
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            if (st.opacity !== '' && Number(st.opacity) < 0.05) return false;
          }
        } catch (e0) { }
        cur = cur.parentNode;
      }
      return true;
    } catch (e) { return false; }
  }

  function votSliderKeys() {
    window.addEventListener('keydown', function (e) {
      var kc = e.keyCode;
      if (kc !== 37 && kc !== 39) return;
      var a = document.activeElement, key = volKeyOf(a);
      if (!key) return;
      if (!nodeOnScreen(a)) {
        // Клавишу не трогаем — она уходит клиенту как обычно.
        if (volIgn < 12) { volIgn++; log('vol slide ignored: row not visible kc=' + kc); }
        return;
      }
      var def = key === 'vol.translate' ? 100 : 0;
      var cur = volPct(key, def);
      var next = cur + (kc === 39 ? 10 : -10);
      if (next < 0) next = 0;
      if (next > 100) next = 100;
      // Своя обработка важнее клиента: иначе вправо уводило бы фокус из панели.
      try { e.preventDefault(); e.stopPropagation(); } catch (x2) { }
      if (next === cur) return;
      uiSet(key, next);
      applyVolume();
      var painted = votPaintValue(a, next);
      uiToast((key === 'vol.translate' ? 'Громкость перевода: ' : 'Оригинал при переводе: ')
        + next + '%', 1800);
      if (volKeyLog < 16) {
        volKeyLog++;
        log('vol slide ' + key + ' ' + cur + '->' + next + ' paint=' + painted);
      }
    }, true);
  }

  // Кнопка в ряду с лайками/комментариями — главный выключатель перевода.
  // Выключение сохраняется (translate.enabled=false), поэтому при переключении
  // на другой ролик перевод САМ не включается. Включение сразу переводит
  // текущий ролик и разрешает автоперевод следующих. Явное нажатие важнее
  // авто-исключения по языку (state.forceTranslate).
  function toggleTranslate() {
    var v = findVideo(), id = state.curId || getVideoId();
    if (isTranslateOn()) {
      state.busy = false;
      state.pendingPlay = null;
      state.wantOn = null;
      state.offForId = id || state.curId;
      uiSet('translate.enabled', false);
      stopAudio(true);
      setStatus('Перевод: выключен для этого ролика', '#90a4ae');
      uiToast('Перевод выключен');
      log('toggle: off id=' + id);
      try { paintToggleBtn(); } catch (e0) { }
      schedulePaint();
      return;
    }
    uiSet('translate.enabled', true);
    uiToast('Перевод включён');
    if (!id) { setStatus('Перевод: включён, откройте видео', '#90a4ae'); return; }
    state.offForId = null;
    state.skipLangBlock = null;
    state.forceTranslate = id;
    state.wantOn = id;
    log('toggle: on id=' + id);
    try { paintToggleBtn(); } catch (e1) { }
    startTranslation(id, (v && v.duration) ? v.duration : 0, state.lang || '');
    schedulePaint();
  }

  function setupUI() {
    if (!window.VOTUI || !VOTUI.on) return;
    VOTUI.init();
    votSliderKeys();
    // Однократная миграция префов. В тестах skipLang сохранился как «en»,
    // из-за чего основной сценарий (англоязычный ролик) молча пропускался.
    // Перевод нужен «с иностранного на русский», поэтому исключён русский.
    if (Number(uiPref('prefs.v', 1)) < 2) {
      uiSet('skipLang', 'ru');
      uiSet('prefs.v', 2);
      log('prefs migrated to v2: skipLang=ru');
    }
    // v3: два независимых уровня — перевод (MediaPlayer моста) и оригинал,
    // который звучит из видео, пока идёт перевод. Раньше vol.original был 100 %,
    // из-за чего оригинал перекрывал перевод.
    if (Number(uiPref('prefs.v', 1)) < 3) {
      uiSet('vol.translate', 100);
      uiSet('vol.original', 0);
      uiSet('prefs.v', 3);
      log('prefs migrated to v3: vol.translate=100 orig=0');
    }
    VOTUI.on('menu.toggle', function () {
      if (VOTUI.isOpen()) VOTUI.close(); else openTranslatePanel();
    });
    VOTUI.on('translate.toggle', function () { toggleTranslate(); });
    VOTUI.on('pref.vol.translate', applyVolume);
    VOTUI.on('pref.vol.original', applyVolume);
    log('ui ready v=' + String(VOTUI.version));
  }
  // ---- кнопка «Перевод» в панели плеера -------------------------------------
  // Панель плеера строит функция из window._yttv, чей код содержит
  // TRANSPORT_CONTROLS_BUTTON_TYPE_*: у неё методы возвращают массив кнопок.
  // Вставляем свой элемент с customAction и перехватываем его в resolveCommand
  // (TizenTube уже патчит resolveCommand, поэтому оборачиваемся поверх него).
  // Тип берём из известных энумов плеера: неизвестный тип рендерер молча
  // выбрасывает (проверено на ТВ — кнопка не появлялась).
  var VOT_BTN_TYPE = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP';
  // Два ряда кнопок плеера. В ряду с лайками/комментариями/шарингом — только
  // включение-выключение перевода, в ряду с настройками/PiP — панель настроек.
  var VOT_ACTION = 'VOT_PANEL_SHOW';
  var VOT_TOGGLE_ACTION = 'VOT_TRANSLATE_TOGGLE';
  var btnLog = 0;
  var popupLog = 0;
  var hookLog = 0;

  function votBtnItem(action, title, selected) {
    return {
      type: VOT_BTN_TYPE,
      button: {
        buttonRenderer: {
          isDisabled: false,
          // Родной рендерер рисует включённое состояние сам (как у субтитров).
          // Если поле игнорируется — подсветку всё равно даёт CSS ниже.
          isSelected: !!selected,
          style: 'STYLE_DEFAULT',
          text: { runs: [{ text: title }] },
          icon: { iconType: 'TRANSLATE' },
          command: { customAction: { action: action } },
          trackingParams: null
        }
      }
    };
  }

  // «Перевод включён» — отсюда и подпись кнопки, и подсветка. Кнопка белая всё
  // время, пока перевод разрешён для текущего ролика, а не только когда звук уже
  // играет: плеер, язык оригинала и аудио готовятся несколько секунд (до ~4.5 с),
  // и кнопка не должна в это время гаснуть.
  function isTranslateOn() {
    if (uiPref('translate.enabled', true) === false) { state.paintOn = false; return false; }
    var id = state.curId;
    if (!id) {
      // Вне watch-страницы (переход между роликами) держим прежнюю подсветку.
      return state.paintOn === true;
    }
    if (state.offForId === id) { state.paintOn = false; return false; }
    if (state.skipLangBlock === id) { state.paintOn = false; return false; }
    state.paintOn = true;
    return true;
  }

  // ---- подсветка кнопки «Перевод» -------------------------------------------
  // Кнопка в баре — родной узел YouTube, который перерисовывается на каждое
  // открытие панели, поэтому: (1) ищем узел по подписи, (2) ставим на него
  // data-vot-toggle/data-vot-on, (3) цвет рисует CSS из vot_ui.js через
  // transition — получается такая же плавная смена, как у кнопки субтитров.
  var paintTimer = null, paintChain = [], paintLog = '', paintMiss = 0, paintMissAt = 0, paintStale = 0;

  function elInfo(el) {
    try {
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      var cls = String(el.className || '').replace(/\s+/g, '.').slice(0, 30);
      return String(el.tagName || '?').toLowerCase() + (cls ? '.' + cls : '')
        + ' bg=' + cs.backgroundColor + ' f=' + cs.fill + '/' + cs.color
        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
    } catch (e) { return '?'; }
  }

  function labelOf(el) {
    try {
      return String(el.getAttribute('aria-label') || '') + '|' + String(el.getAttribute('title') || '');
    } catch (e) { return ''; }
  }

  // Наша кнопка — «Перевод: вкл/выкл»; у пункта меню подпись просто «Перевод»
  // (без состояния), поэтому двоеточие в подписи обязательно, иначе подсветка
  // уезжала бы на пункт меню «Перевод» в настройках.
  function isToggleLabel(s) {
    return s.indexOf('Перевод') >= 0 && s.indexOf('Перевод:') >= 0 && s.indexOf('Яндекс') < 0;
  }

  // Кнопки нет в DOM: панель ещё не отрисована либо рендерер подписал её иначе.
  // Печатаем, что реально лежит в aria-label (V = «Перевод», S = субтитры).
  function dumpLabels() {
    var out = [], a = null, i, cnt = 0, btn = 0, lb = '';
    try { a = document.querySelectorAll('[aria-label]'); } catch (e) { a = null; }
    if (a) {
      for (i = 0; i < a.length; i++) {
        lb = '';
        try { lb = String(a[i].getAttribute('aria-label') || ''); } catch (e2) { continue; }
        if (!lb) continue;
        cnt++;
        if (out.length < 14) {
          out.push(String(a[i].tagName || '?').toLowerCase().slice(0, 12) + ':' + lb.length
            + (lb.indexOf('Перевод') >= 0 ? 'V' : '') + (lb.indexOf('Субтитр') >= 0 ? 'S' : ''));
        }
      }
    }
    try { btn = document.querySelectorAll('yt-button-container').length; } catch (e3) { }
    log('paint: node not found labels=' + cnt + ' btnc=' + btn + ' [' + out.join(' ') + ']');
  }

  // Пункт «Перевод», который мы вставляем в меню настроек, подписан так же, как
  // кнопка в баре (aria-label «Перевод»), поэтому кнопку ищем только ВНЕ оверлеев
  // и попапов — иначе белый кружок красит пункт меню.
  function inOverlay(el) {
    var cur = el, i;
    for (i = 0; i < 9 && cur && cur.tagName; i++) {
      var tag = String(cur.tagName).toLowerCase(), cls = '';
      // Ряд кнопок плеера — точно не оверлей, проверяем его первым.
      if (tag === 'ytlr-player-actions-container') return false;
      try { cls = String(cur.className || '').toLowerCase(); } catch (e0) { cls = ''; }
      if (tag.indexOf('overlay') >= 0 || tag.indexOf('popup') >= 0) return true;
      if (cls.indexOf('overlay') >= 0 || cls.indexOf('popup') >= 0) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  // От иконки поднимаемся к контейнеру кнопки, но не выше: ряд кнопок шире
  // и красить его нельзя (белая плашка на пол-экрана).
  function btnRoot(el) {
    var cur = el, i;
    for (i = 0; i < 4; i++) {
      var up = cur.parentNode;
      if (!up || !up.tagName) break;
      var tag = String(up.tagName).toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      try {
        var r0 = el.getBoundingClientRect(), r1 = up.getBoundingClientRect();
        if (!r0.width || !r1.width) break;
        if (r1.width > 130 || r1.height > 130) break;
        if (r1.width > r0.width * 2.6 || r1.height > r0.height * 2.6) break;
        if (up.querySelectorAll('[aria-label]').length > 2) break;
      } catch (e) { break; }
      cur = up;
    }
    return cur;
  }

  function findToggleNode() {
    var n = null, i, a = null, t = '';
    // Кэш по data-vot-toggle использовать НЕЛЬЗЯ: YouTube переиспользует DOM-узлы
    // кнопок, и наша метка «переезжает» на соседнюю кнопку (на ТВ подсветка
    // уезжала на «Комментарии»). Поэтому каждый раз ищем по подписи.

    // 1) Подпись: рендерер кладёт text.runs[0].text в aria-label/title.
    try { a = document.querySelectorAll('[aria-label],[title]'); } catch (e2) { a = null; }
    if (a) {
      for (i = 0; i < a.length && i < 900; i++) {
        if (inOverlay(a[i])) continue;
        if (!isToggleLabel(labelOf(a[i]))) continue;
        var r = btnRoot(a[i]);
        // Скрытые/ещё не отрисованные копии кнопки (0×0) не красим.
        try {
          var rr0 = r.getBoundingClientRect();
          if (rr0.width < 8 || rr0.height < 8) continue;
        } catch (e7) { }
        r.__votHow = 'label';
        return r;
      }
    }
    // 2) Подпись отрисована текстом: ищем текстовые узлы (XPath точнее перебора).
    try {
      if (document.evaluate) {
        var x = document.evaluate(".//*[text()[contains(.,'Перевод')]]",
          document, null, 6, null), k = 0, e5 = null;
        while ((e5 = x.iterateNext()) && k < 6) {
          k++;
          if (inOverlay(e5)) continue;
          if (!isToggleLabel(String(e5.textContent || ''))) continue;
          var rr = btnRoot(e5);
          rr.__votHow = 'xpath';
          return rr;
        }
      }
    } catch (e3) { }
    // 3) Запасной путь: перебор контейнеров кнопок по textContent.
    try { a = document.querySelectorAll('yt-button-container, ytlr-button, ytlr-icon-button, button'); } catch (e4) { return null; }
    for (i = 0; i < a.length && i < 900; i++) {
      t = '';
      try { t = String(a[i].textContent || ''); } catch (e6) { continue; }
      if (inOverlay(a[i])) continue;
      if (isToggleLabel(t)) { a[i].__votHow = 'text'; return a[i]; }
    }
    return null;
  }

  // Иероглиф на белом кружке — тёмный, подписи (элементы с текстом) — белые.
  // Помечаем иконки атрибутом data-vot-ic; если иконку распознать не удалось
  // (рендерер рисует символ текстом), красим всё содержимое (data-vot-all).
  function markInside(el) {
    var all = null, i, icons = 0, n = null, tag = '', cls = '', txt = '';
    try { all = el.querySelectorAll('*'); } catch (e) { return; }
    for (i = 0; i < all.length && i < 40; i++) {
      n = all[i];
      try {
        tag = String(n.tagName || '').toLowerCase();
        cls = String(n.getAttribute('class') || '');
        txt = String(n.textContent || '').replace(/\s+/g, '');
      } catch (e2) { continue; }
      var icon = (tag === 'svg' || tag === 'path' || tag === 'use' || tag === 'ytlr-icon')
        || cls.indexOf('icon') >= 0;
      if (icon) icons++;
      if (icon || !txt) {
        try { n.setAttribute('data-vot-ic', '1'); } catch (e3) { }
      } else {
        try { n.removeAttribute('data-vot-ic'); } catch (e4) { }
      }
    }
    for (i = 0; i < all.length && i < 40; i++) {
      try {
        if (icons) all[i].removeAttribute('data-vot-all');
        else all[i].setAttribute('data-vot-all', '1');
      } catch (e5) { }
    }
  }

  // Длина подписи узла (своей или у потомка) — в лог, чтобы видеть, что красим
  // именно нашу кнопку («Перевод: вкл/выкл» = 12–13 символов).
  function deepLabelLen(el) {
    var s = '';
    try { s = labelOf(el); } catch (e) { }
    if (s.replace('|', '')) return s.length;
    try {
      var d = el.querySelector('[aria-label]');
      if (d) s = labelOf(d);
    } catch (e2) { }
    return s.length;
  }

  function paintToggleBtn() {
    var el = findToggleNode();
    if (!el) {
      // Диагностика не чаще 1 раза в 8 с и не больше 4 раз: видно, появилась ли
      // панель позже и какие подписи вообще есть в DOM.
      var now = Date.now();
      if (paintMiss < 4 && (!paintMissAt || now - paintMissAt > 8000)) {
        paintMiss++;
        paintMissAt = now;
        paintLog = 'none';
        dumpLabels();
      }
      return;
    }
    var on = isTranslateOn() ? '1' : '0';
    // Снимаем метки со ВСЕХ чужих узлов: узел, который был нашим, рендерер может
    // занять под другую кнопку — тогда белый кружок рисуется у соседа.
    try {
      var stale = document.querySelectorAll('[data-vot-toggle]');
      if (stale.length > 1 || (stale.length === 1 && stale[0] !== el)) {
        for (var j = 0; j < stale.length; j++) {
          if (stale[j] === el) continue;
          stale[j].removeAttribute('data-vot-on');
          stale[j].removeAttribute('data-vot-toggle');
        }
        if (paintStale < 5) {
          paintStale++;
          log('paint stale cleared n=' + stale.length + ' keep=' + (el.__votHow || '?'));
        }
      }
    } catch (e1) { }
    try {
      if (el.getAttribute('data-vot-on') !== on) el.setAttribute('data-vot-on', on);
      el.setAttribute('data-vot-toggle', '1');
    } catch (e2) { }
    // Наследие первой версии (инлайн-стили) убираем: цвет теперь из CSS.
    try {
      var s = el.style;
      if (s && (s.backgroundColor || s.color || s.fill || s.borderRadius)) {
        s.backgroundColor = ''; s.color = ''; s.fill = ''; s.borderRadius = '';
      }
    } catch (e3) { }
    paintChain = [el];
    try { markInside(el); } catch (e4) { }
    if (paintLog !== on) {
      paintLog = on;
      log('paint ' + (on === '1' ? 'on' : 'off') + ' via ' + (el.__votHow || '?')
        + ' lb=' + deepLabelLen(el) + ' ' + elInfo(el));
    }
    verifyPaint(el, on);
  }

  // Узел могли занять под другую кнопку уже после покраски: если через 260 мс
  // подписи нашей на нём нет — снимаем метки и ищем заново.
  function verifyPaint(el, on) {
    setTimeout(function () {
      try {
        if (!document.body || !document.body.contains(el)) { paintLog = ''; schedulePaint(); return; }
        var lb = labelOf(el);
        if (lb.replace('|', '') && !isToggleLabel(lb)) {
          if (paintStale < 8) { paintStale++; log('paint wrong node (lb=' + lb.length + ') cleared'); }
          el.removeAttribute('data-vot-on');
          el.removeAttribute('data-vot-toggle');
          paintLog = '';
          schedulePaint();
          return;
        }
        if (el.getAttribute('data-vot-on') !== on) schedulePaint();
      } catch (e) { }
    }, 260);
  }

  // Панель управления строится заново на каждое открытие, поэтому подсветку
  // переставляем после вставки кнопки (двумя тиками: до и после отрисовки).
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(function () {
      paintTimer = null;
      try { paintToggleBtn(); } catch (e) { }
      setTimeout(function () { try { paintToggleBtn(); } catch (e) { } }, 700);
    }, 350);
  }

  function injectVotBtn(res) {
    if (!res || typeof res.length !== 'number' || !res.length) return res;
    var types = [], at = -1, i;
    for (i = 0; i < res.length; i++) {
      var it = res[i];
      if (!it || typeof it !== 'object' || typeof it.type !== 'string') return res;
      types.push(String(it.type).replace('TRANSPORT_CONTROLS_BUTTON_TYPE_', ''));
      if (at < 0 && it.type.indexOf('PLAYBACK_SETTINGS') >= 0) at = i;
    }
    // Ряд с шестерёнкой не трогаем: панель открывается пунктом «Перевод» в меню
    // настроек. Вторая кнопка в баре (дубль) не нужна.
    if (at >= 0) return res;
    var act = VOT_TOGGLE_ACTION;
    for (i = 0; i < res.length; i++) {
      var bc = res[i] && res[i].button && res[i].button.buttonRenderer && res[i].button.buttonRenderer.command;
      if (actionOf(bc) === act) return res;
    }
    var on = isTranslateOn();
    res.push(votBtnItem(act, on ? 'Перевод: вкл' : 'Перевод: выкл', on));
    schedulePaint();
    if (btnLog < 6) {
      btnLog++;
      log('btn injected [' + types.join('|') + '] end act=' + act);
    }
    return res;
  }

  function wrapListMethods(inst, where) {
    if (!inst) return 0;
    var keys = [], o = inst, d = 0;
    while (o && o !== Object.prototype && d < 4) {
      var ns = Object.getOwnPropertyNames(o);
      for (var i = 0; i < ns.length; i++) if (keys.indexOf(ns[i]) < 0) keys.push(ns[i]);
      o = Object.getPrototypeOf(o); d++;
    }
    var n = 0;
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (k === 'constructor') continue;
      var f = null;
      try { f = inst[k]; } catch (e) { continue; }
      if (typeof f !== 'function' || f.__votWrapped) continue;
      var src = '';
      try { src = Function.prototype.toString.call(f); } catch (e2) { continue; }
      if (src.indexOf('TRANSPORT_CONTROLS_BUTTON_TYPE_') < 0) continue;
      inst[k] = (function (orig) {
        var w = function () { return injectVotBtn(orig.apply(this, arguments)); };
        w.__votWrapped = 1;
        return w;
      })(f);
      n++;
    }
    if (n && btnLog < 8) { btnLog++; log('btn methods ' + n + ' via ' + where + ' keys=' + keys.length); }
    return n;
  }

  function actionOf(cmd) {
    if (!cmd || typeof cmd !== 'object') return '';
    if (cmd.customAction && cmd.customAction.action) return String(cmd.customAction.action);
    if (cmd.signalAction && cmd.signalAction.customAction && cmd.signalAction.customAction.action) {
      return String(cmd.signalAction.customAction.action);
    }
    return '';
  }

  // Пункт «Перевод Яндекс» в нативном меню настроек плеера (шестерёнка). Внутри
  // пункта лежит готовая команда нашей панели: клиент откроет её сам, как
  // «Качество» — стопкой плашек справа, с родной анимацией и навигацией.
  function votPopupItem() {
    var cmd = votPanelCmd('vot-settings');
    var lr = {
      title: { simpleText: 'Перевод Яндекс' },
      icon: { iconType: 'TRANSLATE' },
      // Стрелка — как у плашек, открывающих подменю («Скорость», «Пожалуйста»).
      secondaryIcon: { iconType: 'CHEVRON_RIGHT' }
    };
    if (cmd) {
      lr.serviceEndpoint = { commandExecutorCommand: { commands: [cmd] } };
    } else {
      // Шаблон не поймали (настройки ещё не открывались) — DOM-панель.
      lr.serviceEndpoint = { commandExecutorCommand: { commands: [{ customAction: { action: VOT_ACTION } }] } };
    }
    return { compactLinkRenderer: lr };
  }

  function collectItemLists(obj, out, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10 || out.length > 24) return out;
    if (Object.prototype.toString.call(obj) === '[object Array]') {
      for (var i = 0; i < obj.length && i < 60; i++) collectItemLists(obj[i], out, depth + 1);
      return out;
    }
    for (var k in obj) {
      var v = null;
      try { v = obj[k]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      if (Object.prototype.toString.call(v) === '[object Array]') out.push(v);
      else collectItemLists(v, out, depth + 1);
    }
    return out;
  }

  // «Перевод» должен быть только в КОРНЕ меню настроек. Признак корня — его
  // uniqueId (`playback-settings`), как в TizenTube: по вложенности отличить
  // корень от подменю нельзя (в подменю тоже есть openPopupAction).

  function linkTitle(it) {
    try {
      var t = it && it.compactLinkRenderer && it.compactLinkRenderer.title;
      if (!t) return '?';
      return String(t.simpleText || (t.runs && t.runs[0] && t.runs[0].text) || '?').slice(0, 22);
    } catch (e) { return '?'; }
  }

  // Список пунктов корня меню настроек: сначала пробуем известный путь
  // TizenTube (overlayPanelItemListRenderer.items), иначе — любой список.
  function popupItemLists(cmd) {
    var res = [], oa = cmd && cmd.openPopupAction, arr = null;
    try {
      var o = oa.popup, s = o && o.overlaySectionRenderer, ov = s && s.overlay;
      var tp = ov && ov.overlayTwoPanelRenderer;
      var ap = tp && tp.actionPanel, pan = ap && ap.overlayPanelRenderer;
      var ct = pan && pan.content, lst = ct && ct.overlayPanelItemListRenderer;
      arr = lst && lst.items;
    } catch (e) { arr = null; }
    if (arr && arr.length) res.push(arr);
    else res = collectItemLists(cmd, [], 0);
    return res;
  }

  function popupHasOurs(arr) {
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      if (!it || !it.compactLinkRenderer) continue;
      var ic = it.compactLinkRenderer.serviceEndpoint
        && it.compactLinkRenderer.serviceEndpoint.commandExecutorCommand
        && it.compactLinkRenderer.serviceEndpoint.commandExecutorCommand.commands;
      if (!ic) continue;
      for (var q = 0; q < ic.length; q++) {
        if (actionOf(ic[q]) === VOT_ACTION) return true;
        var uid = '';
        try { uid = String((ic[q].openPopupAction || {}).uniqueId || ''); } catch (e) { uid = ''; }
        if (uid.indexOf('vot-') === 0) return true;
      }
    }
    return false;
  }

  // Пункт «Перевод» вставляем ТОЛЬКО в корень меню настроек (uniqueId
  // `playback-settings`): в подменю/спойлерах он не нужен — иначе дублируется.
  // Вызывается до и после оригинала: попап может собираться внутри вызова,
  // повторная вставка безопасна (проверка popupHasOurs).
  function popupInsert(cmd) {
    if (!cmd || typeof cmd !== 'object' || !cmd.openPopupAction) return 0;
    if (cmd.__votOwn) return 0; // своя панель: пункт «Перевод» в ней не нужен
    if (String(cmd.openPopupAction.uniqueId || '') !== 'playback-settings') return 0;
    // Шаблон для наших панелей: та же команда, что клиент сейчас отрисует.
    votTpl = cmd;
    var lists = popupItemLists(cmd), i;
    for (i = 0; i < lists.length; i++) {
      var arr = lists[i];
      if (!arr || !arr.length) continue;
      if (popupHasOurs(arr)) continue;
      arr.splice(Math.min(2, arr.length), 0, votPopupItem());
      if (popupLog < 12) {
        popupLog++;
        var tt = [];
        for (var j = 0; j < arr.length && j < 6; j++) tt.push(linkTitle(arr[j]));
        log('popup item inserted n=' + arr.length + ' [' + tt.join(' / ') + ']');
      }
      return 1;
    }
    return 0;
  }

  // Перехват диспетчера команд. Помимо своего действия (кнопка/пункт панели)
  // вставляем пункт «Перевод» в попап: до вызова оригинала (как TizenTube —
  // данные уже готовы к рендеру) и после (если попап собирается внутри).
  function hookMethod(inst, where, name, doPopup) {
    if (!inst) return 0;
    var rc = inst[name];
    if (typeof rc !== 'function' || rc.__votHooked) return 0;
    var h = function (cmd) {
      // Держим ссылки на диспетчеры: шаблон корня настроек и тот инстанс,
      // который открывает вложенные панели (Качество/Субтитры). Свою панель
      // отправляем именно второму — он умеет строить стопку плашек.
      try {
        if (!inst.__votId) inst.__votId = ++instSeq;
        if (name === 'resolveCommand' && cmd && cmd.openPopupAction) {
          var uid = String(cmd.openPopupAction.uniqueId || '');
          if (popupInstLog < 24) {
            popupInstLog++;
            log('popup inst=' + inst.__votId + ' uid=' + (uid || '-')
              + ' own=' + (cmd.__votOwn ? 1 : 0) + ' w=' + where);
          }
        }
      } catch (e9) { }
      try {
        if (handleAction(actionOf(cmd))) return true;
        var cc = cmd && cmd.commandExecutorCommand && cmd.commandExecutorCommand.commands;
        if (cc && cc.length) {
          for (var i = 0; i < cc.length; i++) {
            if (handleAction(actionOf(cc[i]))) return true;
          }
        }
      } catch (e) { }
      if (doPopup && cmd && cmd.openPopupAction) {
        try { popupInsert(cmd); } catch (e1) { log('popup pre ERR ' + (e1 && e1.message)); }
      }
      var r = rc.apply(this, arguments);
      if (doPopup && cmd && cmd.openPopupAction) {
        try { popupInsert(cmd); } catch (e2) { log('popup ERR ' + (e2 && e2.message)); }
      }
      return r;
    };
    h.__votHooked = 1;
    try { inst[name] = h; } catch (e3) { return 0; }
    if (hookLog < 24) { hookLog++; log(name + ' hooked via ' + where); }
    return 1;
  }

  function hookResolve(inst, where) {
    if (!inst) return 0;
    var n = hookMethod(inst, where, 'resolveCommand', true);
    // Часть команд (в т.ч. меню настроек) идёт мимо resolveCommand.
    n += hookMethod(inst, where, 'dispatchCommand', true);
    n += hookMethod(inst, where, 'executeCommand', true);
    return n;
  }

  function hookAllInstances() {
    if (!window._yttv) return 0;
    var n = 0;
    for (var k in window._yttv) {
      var e = null;
      try { e = window._yttv[k]; } catch (x) { continue; }
      if (!e) continue;
      try { if (e.instance) n += hookResolve(e.instance, k + '.instance'); } catch (x2) { }
      try { if (e.prototype) n += hookResolve(e.prototype, k + '.prototype'); } catch (x3) { }
    }
    return n;
  }

  function installPlayerButton() {
    if (!window._yttv) return false;
    hookAllInstances();
    // Повторная инъекция скрипта: обёртка уже стоит, только до-патчиваем инстансы.
    var prev = window.__votBtnKey;
    if (prev && typeof window._yttv[prev] === 'function' && window._yttv[prev].__votWrapped) {
      try { if (window._yttv[prev].instance) wrapListMethods(window._yttv[prev].instance, 'instance2'); } catch (e0) { }
      return true;
    }
    var key = null, fn = null;
    for (var k in window._yttv) {
      var v = window._yttv[k];
      if (typeof v !== 'function' || v.__votWrapped) continue;
      var src = '';
      try { src = Function.prototype.toString.call(v); } catch (e) { continue; }
      if (src.indexOf('TRANSPORT_CONTROLS_BUTTON_TYPE_') < 0) continue;
      if (src.indexOf('PLAYBACK_SETTINGS') < 0) continue;
      key = k; fn = v; break;
    }
    if (!key) return false;
    try { if (window._yttv[key].instance) wrapListMethods(window._yttv[key].instance, 'instance'); } catch (e4) { }
    if (window._yttv[key] !== fn) return true; // только что обернули
    var W = function () {
      // Строка ниже нужна, чтобы фильтр TizenTube (поиск по коду функции) продолжал
      // находить нашу обёртку: TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS
      // TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION
      var args = Array.prototype.slice.call(arguments), obj = null;
      try {
        // Reflect — ES6; в Cobalt его может не быть вовсе, поэтому проверяем
        // существование объекта, а не свойство (иначе ReferenceError).
        obj = (typeof Reflect !== 'undefined' && Reflect.construct)
          ? Reflect.construct(fn, args, fn)
          : new (Function.prototype.bind.apply(fn, [null].concat(args)))();
      } catch (e) { log('btn ctor ERR ' + (e && e.message)); throw e; }
      try { wrapListMethods(obj, 'ctor'); hookResolve(obj, 'ctor'); } catch (e2) { log('btn ctor patch ERR ' + (e2 && e2.message)); }
      return obj;
    };
    W.prototype = fn.prototype;
    W.__votWrapped = 1;
    window._yttv[key] = W;
    window.__votBtnKey = key;
    log('btn ctor wrapped key=' + key);
    return true;
  }

  var btnTries = 0;
  function btnRetry() {
    btnTries++;
    var ok = false;
    try { ok = installPlayerButton(); } catch (e) { log('btn install ERR ' + (e && e.message)); }
    if (!ok && btnTries < 40) setTimeout(btnRetry, 1500);
  }

  // Новые диспетчеры команд появляются и после старта (меню настроек собирается
  // при первом открытии шестерёнки). Перепроверяем _yttv, чтобы не пропустить их.
  var rehookN = 0;
  var rehookT = setInterval(function () {
    rehookN++;
    try { hookAllInstances(); } catch (e) { }
    if (rehookN >= 600) clearInterval(rehookT); // ~20 мин
  }, 2000);
  // ===== VOT-UI END =====

  // ---- сторож интерфейса плеера ---------------------------------------------
  // Пользователь сообщил: «иногда в какой-то момент пропадает интерфейс плеера,
  // все кнопки; помогает перезапуск». Чтобы понять, что именно исчезает (узлы
  // ряда, видимость, наша панель), раз в ~2.4 с снимаем компактный срез DOM и
  // пишем его в лог ТОЛЬКО при изменении. Строки вида `ui rows=1 btn=4 lb=9
  // vis=1 432x72 our=1 panel=0 af=body`.
  var uiPrev = '', uiLog = 0;

  function uiSample() {
    var rows = null, n = 0, lb = 0, vis = 0, w = 0, h = 0, i;
    try { rows = document.querySelectorAll('ytlr-player-actions-container'); } catch (e) { rows = null; }
    if (rows) {
      for (i = 0; i < rows.length; i++) {
        try {
          n += rows[i].querySelectorAll('ytlr-button-renderer').length;
          lb += rows[i].querySelectorAll('[aria-label]').length;
          var b = rows[i].getBoundingClientRect();
          if (b.width > 0 && b.height > 0) { vis++; w = Math.round(b.width); h = Math.round(b.height); }
        } catch (e2) { }
      }
    }
    var ours = 0;
    try { ours = document.querySelectorAll('[data-vot-toggle]').length; } catch (e3) { }
    var pn = 0, toast = 0;
    try {
      var rt = document.getElementById('vot-ui-root');
      pn = (rt && String(rt.className).indexOf('vot-open') >= 0) ? 1 : 0;
      var ts = document.getElementById('vot-toast');
      toast = (ts && ts.style.display === 'block') ? 1 : 0;
    } catch (e4) { }
    var af = '-';
    try { af = document.activeElement ? String(document.activeElement.tagName || '').toLowerCase().slice(0, 12) : '-'; } catch (e5) { }
    return 'rows=' + (rows ? rows.length : -1) + ' btn=' + n + ' lb=' + lb + ' vis=' + vis
      + ' ' + w + 'x' + h + ' our=' + ours + ' panel=' + pn + ' toast=' + toast + ' af=' + af;
  }

  function uiWatch() {
    var s = uiSample();
    if (s === uiPrev) return;
    uiPrev = s;
    if (uiLog < 120) { uiLog++; log('ui ' + s); }
  }

  // Подсветка кнопки должна совпадать с состоянием перевода всегда — в том
  // числе после переключения ролика при уже открытой панели. Тик дешёвый:
  // пока data-vot-on совпадает, DOM не меняется.
  var uiTickN = 0;
  setInterval(function () {
    uiTickN++;
    try {
      if (!state.curId || document.hidden) return;
      // Сторож интерфейса: раз в два тика (~2.4 с), только на странице ролика.
      if (uiTickN % 2 === 0) uiWatch();
      paintToggleBtn();
    } catch (e) { }
  }, 1200);


  // Рендерер переиспользует DOM-узлы кнопок и меняет им aria-label. Ловим такие
  // правки сразу: как только подпись узла перестала быть нашей — снимаем метки
  // (иначе белый кружок остаётся на чужой кнопке до следующего тика).
  var moTimer = null;
  try {
    if (window.MutationObserver) {
      var mo = new MutationObserver(function (recs) {
        var hit = false;
        for (var i = 0; i < recs.length && !hit; i++) {
          var r = recs[i];
          if (r.type !== 'attributes' || !r.target) continue;
          if (!r.target.getAttribute || !r.target.getAttribute('data-vot-toggle')) continue;
          var lb = labelOf(r.target);
          if (lb.replace('|', '') && !isToggleLabel(lb)) {
            try {
              r.target.removeAttribute('data-vot-on');
              r.target.removeAttribute('data-vot-toggle');
            } catch (e0) { }
            if (paintStale < 8) { paintStale++; log('paint recycle cleared lb=' + lb.length); }
            paintLog = '';
          }
          hit = true;
        }
        if (hit && !moTimer) {
          moTimer = setTimeout(function () { moTimer = null; try { paintToggleBtn(); } catch (e1) { } }, 120);
        }
      });
      mo.observe(document.documentElement || document.body, {
        attributes: true, attributeFilter: ['aria-label', 'title'], subtree: true
      });
    }
  } catch (e2) { log('MO ERR ' + (e2 && e2.message)); }

  setupUI();
  btnRetry();

})();

;
/* -*- coding: utf-8 -*-
 * VOT net probe — НИЧЕГО не скачивает и не запрашивает у YouTube.
 *
 * Смотрит только на то, что штатный плеер ТВ и так делает сам:
 *   - player-ответ (/youtubei/v1/player), который получает страница;
 *   - player_response из ytcfg (если он там есть);
 *   - запросы к googlevideo.com (itag/range/наличие n).
 * Пишет короткие строки в лог моста (POST /log). Нужен ровно для одного
 * вопроса: есть ли у ТВ-клиента ПРЯМЫЕ аудио-url, которые уже работают.
 * Ничего не патчит в UI, не мешает воспроизведению, лимит 40 строк.
 */
(function () {
  if (window.__VOT_NET_STARTED) return;
  window.__VOT_NET_STARTED = 1;

  var MARK = '[VOT-net]';
  var BRIDGE = 'http://127.0.0.1:8013';
  var LIMIT = 40;
  var sent = 0;
  var seen = {};

  function post(text) {
    if (sent >= LIMIT) return;
    sent++;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + '/log', true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(MARK + ' ' + String(text).slice(0, 200));
    } catch (e) { }
  }

  function once(key, text) {
    if (seen[key]) return;
    seen[key] = 1;
    post(text);
  }

  function short(u) {
    return String(u || '').replace(/^https?:\/\//, '').slice(0, 150);
  }

  function isPlayer(i) {
    return String(i || '').indexOf('/youtubei/v1/player') >= 0;
  }

  function hasN(u) {
    return /[?&]n=/.test(String(u || '')) ? 1 : 0;
  }

  // Сводка по streamingData: сколько форматов с прямым url, у скольких есть n,
  // сколько зашифровано, и то же самое только для аудио.
  function countFmts(j) {
    var sd = (j && j.streamingData) || null;
    if (!sd) return 'no streamingData';
    var af = sd.adaptiveFormats || [];
    var url = 0, urlN = 0, cipher = 0, aUrl = 0, aUrlN = 0;
    for (var i = 0; i < af.length; i++) {
      var f = af[i] || {};
      var u = f.url || '';
      var mime = String(f.mimeType || '');
      var itag = Number(f.itag) || 0;
      var audio = mime.indexOf('audio/') === 0 || (itag >= 139 && itag <= 141)
        || itag === 249 || itag === 250 || itag === 251;
      if (u) {
        url++;
        if (hasN(u)) urlN++;
        if (audio) { aUrl++; if (hasN(u)) aUrlN++; }
      } else if (f.signatureCipher || f.cipher) {
        cipher++;
      }
    }
    return 'adapt=' + af.length + ' url=' + url + ' urlN=' + urlN + ' cipher=' + cipher
      + ' audioUrl=' + aUrl + ' audioUrlN=' + aUrlN
      + ' sabr=' + (sd.serverAbrStreamingUrl ? 1 : 0);
  }

  function onPlayer(xhr) {
    var rt = '';
    try { rt = String(xhr.responseType || ''); } catch (e) { }
    if (rt && rt !== 'text') { once('player-bin', 'player resp binary responseType=' + rt); return; }
    var t = '';
    try { t = String(xhr.responseText || ''); } catch (e) { return; }
    if (!t || t.indexOf('streamingData') < 0) {
      once('player-nosd', 'player resp no streamingData len=' + t.length);
      return;
    }
    var j = null;
    try { j = JSON.parse(t); } catch (e) { once('player-json', 'player resp parse err len=' + t.length); return; }
    var ps = (j && j.playabilityStatus) || {};
    once('player', 'player resp len=' + t.length + ' status=' + (ps.status || '?') + ' ' + countFmts(j));
  }

  function patchXhr() {
    var P = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (!P || P.__votNet) return !!P;
    var oOpen = P.open, oSend = P.send;
    P.open = function (m, u) {
      try { this.__votU = String(u || ''); } catch (e) { }
      return oOpen.apply(this, arguments);
    };
    P.send = function () {
      var u = '';
      try { u = this.__votU || ''; } catch (e) { }
      if (isPlayer(u)) {
        var self = this;
        try { this.addEventListener('loadend', function () { onPlayer(self); }); } catch (e) { }
      } else if (String(u).indexOf('googlevideo.com') >= 0) {
        var host = short(u).split('/')[0];
        var itag = (/[?&]itag=(\d+)/.exec(u) || [])[1] || '?';
        var rng = (/[?&]range=([\d-]+)/.exec(u) || [])[1] || '-';
        once('gv|' + host + '|' + itag + '|' + rng,
          'gv req host=' + host + ' itag=' + itag + ' range=' + rng + ' n=' + hasN(u));
      }
      return oSend.apply(this, arguments);
    };
    P.__votNet = 1;
    return true;
  }

  function patchFetch() {
    if (!window.fetch || window.fetch.__votNet) return !!window.fetch;
    var of = window.fetch;
    var nf = function (input) {
      var u = '';
      try { u = typeof input === 'string' ? input : ((input && input.url) || ''); } catch (e) { }
      var p = of.apply(this, arguments);
      try {
        if (isPlayer(u)) {
          p.then(function (r) {
            try {
              r.clone().text().then(function (t) {
                var j = null;
                try { j = JSON.parse(t); } catch (e) { return; }
                var ps = (j && j.playabilityStatus) || {};
                once('fplayer', 'fetch player len=' + t.length + ' status=' + (ps.status || '?') + ' ' + countFmts(j));
              });
            } catch (e) { }
          });
        } else if (String(u).indexOf('googlevideo.com') >= 0) {
          var host = short(u).split('/')[0];
          var itag = (/[?&]itag=(\d+)/.exec(u) || [])[1] || '?';
          once('fgv|' + host + '|' + itag,
            'fetch gv host=' + host + ' itag=' + itag + ' n=' + hasN(u));
        }
      } catch (e) { }
      return p;
    };
    nf.__votNet = 1;
    try { window.fetch = nf; } catch (e) { return false; }
    return true;
  }

  // player_response, который клиент кладёт в конфиг (если кладёт) — самый
  // дешёвый источник: его не надо ни у кого просить.
  function tryYtcfg() {
    var raw = '';
    try {
      if (window.ytcfg && ytcfg.get) {
        var pc = ytcfg.get('PLAYER_CONFIG');
        if (pc && pc.args && pc.args.player_response) raw = String(pc.args.player_response);
        if (!raw) {
          var pv = ytcfg.get('PLAYER_VARS');
          if (pv && pv.player_response) raw = String(pv.player_response);
        }
      }
    } catch (e) { }
    if (!raw) { once('cfg-none', 'ytcfg no player_response'); return; }
    try {
      var j = JSON.parse(raw);
      var ps = j.playabilityStatus || {};
      once('cfg-pr', 'ytcfg player_response len=' + raw.length + ' status=' + (ps.status || '?') + ' ' + countFmts(j));
    } catch (e) {
      once('cfg-err', 'ytcfg player_response parse err len=' + raw.length);
    }
  }

  // Отправка перехваченных байтов в мост: /cap/begin (init), /cap/chunk, /cap/end.
  // Очередь строго последовательная (begin должен лечь первым), буфер ограничен,
  // при переполнении чанки дропаются — плеер важнее.
  var CAP_LIMIT = 24 * 1024 * 1024;
  var CAP_QBUF = 8 * 1024 * 1024;
  // Захват включается только конфигом моста (audioMode:"capture"): он копирует
  // каждый аудиосегмент и держит до 24 МБ в кэше ТВ, а нужен редко.
  var CAP_ON = false;
  var CAP = { vid: '', started: 0, sent: 0, qbytes: 0, q: [], busy: 0, dropped: 0, done: 0 };

  function capVideoId() {
    // На ТВ (LIVING_ROOM) id живёт в hash: `#/watch?v=...`, а не в search.
    try {
      var m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(String(location.href || ''));
      if (m) return m[1];
    } catch (e) { }
    try {
      if (window.ytcfg && ytcfg.get) {
        var v = String(ytcfg.get('VIDEO_ID') || '');
        if (v) return v;
      }
    } catch (e) { }
    return '';
  }

  function capBytes(buf) {
    try {
      if (!buf) return null;
      if (buf instanceof ArrayBuffer) return new Uint8Array(buf.slice(0));
      if (buf.buffer) {
        return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      }
    } catch (e) { }
    return null;
  }

  function capSend(path, bytes, cb) {
    var x = new XMLHttpRequest();
    CAP.busy++;
    x.onloadend = function () {
      CAP.busy--;
      if (cb) { try { cb(x.responseText || ''); } catch (e) { } }
    };
    try {
      x.open('POST', BRIDGE + path, true);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.send(bytes || null);
    } catch (e) { CAP.busy--; }
  }

  function capNext() {
    if (!CAP.started || CAP.busy > 0 || !CAP.q.length) return;
    var b = CAP.q.shift();
    CAP.qbytes -= b.length;
    capSend('/cap/chunk', b, capNext);
  }

  function capPush(bytes) {
    if (!CAP_ON) return;
    if (!bytes || !bytes.length || CAP.done) return;
    var id = capVideoId();
    if (!id) return;
    if (id !== CAP.vid) {
      CAP.vid = id;
      CAP.started = 1;
      CAP.sent = bytes.length;
      CAP.dropped = 0;
      CAP.done = 0;
      CAP.q.length = 0;
      CAP.qbytes = 0;
      var init = bytes;
      capSend('/cap/begin?videoId=' + encodeURIComponent(id), init, function (r) {
        post('cap begin vid=' + id + ' init=' + init.length + ' r=' + String(r).slice(0, 70));
        capNext();
      });
      return;
    }
    if (CAP.sent + bytes.length > CAP_LIMIT) {
      CAP.done = 1;
      capSend('/cap/end', null, function (r) {
        post('cap limit vid=' + id + ' sent=' + CAP.sent + ' dropped=' + CAP.dropped + ' r=' + String(r).slice(0, 70));
      });
      return;
    }
    if (CAP.qbytes + bytes.length > CAP_QBUF) { CAP.dropped++; return; }
    CAP.q.push(bytes);
    CAP.qbytes += bytes.length;
    CAP.sent += bytes.length;
    capNext();
  }

  // Путь E: плеер уже получает звук по SABR и отдаёт его в MSE. Перехватываем
  // appendBuffer у аудио-SourceBuffer: прямых googlevideo-ссылок в player-ответе
  // нет вообще (url=0/audioUrl=0), значит единственный источник байтов — MSE.
  // Пока только считаем размеры: подтверждаем, что hook живой и трек AAC идёт.
  var MSE = { hooked: 0, sb: 0, ap: 0, bytes: 0, init: 0 };
  function isAudioMime(m) {
    return /audio\/mp4|mp4a|opus/i.test(String(m || ''));
  }
  function hookMse() {
    try {
      var MS = window.MediaSource;
      if (!MS || !MS.prototype || !MS.prototype.addSourceBuffer) return 0;
      if (MS.prototype.__votHooked) return 1;
      var oa = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (m) {
        var sb = oa.apply(this, arguments);
        try {
          if (sb && isAudioMime(m)) {
            MSE.sb++;
            once('mse-sb' + MSE.sb, 'mse addSourceBuffer ' + String(m).slice(0, 60));
            var ap = sb.appendBuffer;
            if (ap) {
              sb.appendBuffer = function (buf) {
                try {
                  var n = (buf && (buf.byteLength || buf.length)) || 0;
                  MSE.ap++;
                  MSE.bytes += n;
                  capPush(capBytes(buf));
                  if (MSE.ap === 1) {
                    MSE.init = n;
                    post('mse first append ' + n + 'B mime=' + String(m).slice(0, 40));
                  } else if (MSE.ap % 20 === 0) {
                    post('mse appends=' + MSE.ap + ' bytes=' + MSE.bytes + ' init=' + MSE.init
                      + ' cap=' + CAP.sent + ' drop=' + CAP.dropped);
                  }
                } catch (e) { }
                return ap.apply(this, arguments);
              };
            }
          }
        } catch (e) { }
        return sb;
      };
      MS.prototype.__votHooked = 1;
      MSE.hooked = 1;
      return 1;
    } catch (e) { return 0; }
  }

  // Путь E требует AAC: Яндекс принимает только mp4/aac, а ТВ по умолчанию
  // получает opus/webm (проверено: `audio/webm; codecs="opus"`). Заставляем
  // плеер выбрать AAC, отказывая в audio/webm|opus, не трогая видеокодеки.
  function isAudioCodec(s, m) {
    return s.indexOf('audio/') === 0 || /codecs="?opus/.test(s);
  }
  function patchCodecs() {
    // Принудительный AAC нужен только захвату (путь E). При audioMode:"off"
    // выбор кодека плеера не трогаем: иначе мы отбираем opus у обычного
    // воспроизведения без всякой пользы.
    if (!CAP_ON) return 0;
    try {
      var MS = window.MediaSource;
      if (!MS || MS.__votCodec || !MS.isTypeSupported) return 0;
      var orig = MS.isTypeSupported;
      MS.isTypeSupported = function (m) {
        var s = String(m || '').toLowerCase();
        try {
          if (isAudioCodec(s, m) && /webm|ogg|opus/.test(s)) {
            once('codec-r-' + s.slice(0, 40), 'codec reject ' + String(m).slice(0, 70));
            return false;
          }
          if (isAudioCodec(s, m)) {
            once('codec-a-' + s.slice(0, 40), 'codec ask ' + String(m).slice(0, 70)
              + ' -> ' + orig.apply(MS, arguments));
          }
        } catch (e) { }
        return orig.apply(MS, arguments);
      };
      MS.__votCodec = 1;
      return 1;
    } catch (e) { return 0; }
  }

  function report() {
    var pir = 0, cfg = 0, mse = 0;
    try { pir = window.ytInitialPlayerResponse ? 1 : 0; } catch (e) { }
    try { cfg = (window.ytcfg && ytcfg.get) ? 1 : 0; } catch (e) { }
    try { mse = window.MediaSource ? 1 : 0; } catch (e) { }
    post('boot pir=' + pir + ' ytcfg=' + cfg + ' mse=' + mse
      + ' xhr=' + (patchXhr() ? 1 : 0) + ' fetch=' + (patchFetch() ? 1 : 0)
      + ' mseh=' + (hookMse() ? 1 : 0) + ' codec=' + (patchCodecs() ? 1 : 0));
  }

  report();
  tryYtcfg();

  // Захват в MSE (путь E) включаем только если конфиг моста этого просит.
  try {
    var cx = new XMLHttpRequest();
    cx.open('GET', BRIDGE + '/config', true);
    cx.onreadystatechange = function () {
      if (cx.readyState !== 4 || cx.status !== 200) return;
      try { CAP_ON = (JSON.parse(cx.responseText) || {}).audioMode === 'capture'; } catch (e) { }
      if (!CAP_ON) return;
      post('cap on');
      // Принудительный AAC имеет смысл только теперь (см. patchCodecs).
      patchCodecs();
    };
    cx.send(null);
  } catch (e) { }

  // Плеер поднимается позже и может заменить конструктор — дооборачиваем.
  var tries = 0;
  var t = setInterval(function () {
    tries++;
    patchXhr();
    patchFetch();
    hookMse();
    if (tries === 2 || tries === 4) tryYtcfg();
    if (tries >= 20) clearInterval(t);
  }, 1500);
})();

;
