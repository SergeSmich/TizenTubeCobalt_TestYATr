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
    'stroke:#0f0f0f !important;}'
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
  var root = null, panelEl = null, listEl = null, titleEl = null, subEl = null, hintEl = null;
  var cur = null, stack = [];
  var geomN = 0;

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
  // Отдельного окна больше нет: все уведомления показывает единая витрина
  // статуса в vot.js (фиксированный размер, гаснет вместе с баром плеера).
  function toast(msg, ms) {
    var h = window.VOT_STATUS_TOAST;
    if (typeof h === 'function') { try { h(msg, ms); } catch (e) { log('toast ERR ' + (e && e.name)); } }
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
    // Android TV MENU может попадать в Chromium как 82, ContextMenu (93)
    // либо вообще только как KeyboardEvent.key; 18 — старый маппинг Cobalt.
    var menuKey = kc === KEY.MENU || kc === 82 || kc === 93 ||
      e.key === 'ContextMenu' || e.key === 'Menu';
    var nav = (kc === KEY.UP || kc === KEY.DOWN || kc === KEY.LEFT || kc === KEY.RIGHT ||
      kc === KEY.ENTER || kc === KEY.BACK || menuKey);
    // Панель «открыта» по состоянию, но на экране её нет (клиент успел закрыть
    // свой попап, анимация не дошла, root потерял класс) — тогда мы глушили ВЕСЬ
    // пульт при невидимом оверлее. Сверяемся с фактическим классом root.
    if (cur) {
      var shown = false;
      try { shown = !!(root && String(root.className).indexOf('vot-open') >= 0); } catch (e0) { }
      if (!shown) { cur = null; stack = []; log('key: stale panel, release keys'); }
    }
    if (cur) {
      if (nav) { e.preventDefault(); e.stopPropagation(); }
      if (e.type !== 'keydown') return;
      // Пока наша панель открыта, удержание MENU не должно её переоткрывать.
      if (menuKey && e.repeat) return;
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
      } else if (menuKey) {
        close();
      }
      return;
    }
    if (e.type !== 'keydown') return;
    // Нет собственной popup-панели вне плеера: MENU/F4 оставляем клиенту/ТВ.
    if (kc === KEY.F3) { e.preventDefault(); e.stopPropagation(); fire('translate.toggle'); }
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
  // У роликов без речи (трейлеры, музыка, шумы) Яндекс отвечает status=2 с
  // rem=5 и может не двигать подсказку минутами; но job на сервере при этом
  // иногда всё-таки доготовится (проверено на oKIkvEjI2WE: rem=5 несколько
  // минут, потом status=1). Поэтому сначала просто разряжаем опросы, а
  // отказываемся только когда прогресса нет совсем.
  var STALL_SOFT = 12;      // ~60 с без движения rem → реже опрашиваем
  var STALL_DELAY = 15000;  // пауза в стагнации
  var STALL_LIMIT = 24;     // 12×5 с + 12×15 с ≈ 4 мин без движения → отказ
  // How long we wait for the page player to actually land on 0:00 when we
  // rewind the video as the translation starts.
  var RESTART_MAX_WAIT = 4000;
  // Сколько ждём язык оригинала, когда перевод уже готов, а язык ещё неизвестен
  // (перевод не запускаем, пока не знаем, что ролик не на исключённом языке).
  // Источник — мост (/source и /meta_local), ответ приходит за 0.1-1 с;
  // таймаут ограничивает худший случай, чтобы перевод не потерялся навсегда.
  var LANG_GATE_MS = 6000;
  // Паузы между опросами языка оригинала: мост отвечает быстро, поэтому первые
  // попытки частые — иначе язык приезжал только через 2.5 с и гейт старта зря
  // тормозил.
  var META_GAPS = [500, 1200, 3000, 6000];
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
    pageRelay: false,   // мост отдал url странице: части качаем своим XHR
    retried: false,
    cfg: null,
    livelyVoice: false,
    // Yandex keys its per-video translation cache by the *source* language
    // shard (field 8). vot.js/SmartTube send "en", and that shard is filled by
    // everybody, so it is almost always warm: the answer comes back in ~0.3 s.
    // We used to send "auto", which is a separate, nearly empty shard — every
    // request started a fresh synthesis (~50 s) or ended in status 6.
    lang: 'en',
    // Язык оригинала и последний статус для панели. Пустые по умолчанию:
    // язык становится известен асинхронно (мост: /source, /meta_local).
    origLang: '',
    // Язык дорожки, которую плеер реально отдаёт в SABR (`xtags`): это то, что
    // звучит на ТВ, включая автодуб (`acont=dubbed-auto:lang=xx`). Приходит на
    // первом же POST плеера, поэтому доступен раньше InnerTube-метаданных.
    audioLang: '',
    audioAcont: '',
    audioDubbed: false,
    // Дорожка из SABR-запроса плеера: id (`en-US.4`) и признак того, что роль
    // подтверждена player-ответом (xtags), а не выведена из одного id.
    audioTrackId: '',
    audioMapped: false,
    // Автодуб на «моём языке» (prefLang): предложение выбрать автодуб или
    // перевод Яндекса. `dubOffer` — id ролика, для которого предложение висит,
    // `dubPick` — что выбрал пользователь ('dub' | 'yandex'). Оба на ролик.
    dubOffer: null,
    dubPick: null,
    uiStatus: '',
    altLangTried: false,
    audioTried: false,
    playedOnce: false,
    restarting: false,
    lastSeek: 0,
    // id ролика, перевод которого отменён навсегда: язык оригинала оказался
    // исключённым (skipLang). Сбрасывается при смене ролика.
    skipLangBlock: null,
    // Автостарт удержан, пока не известен язык звука этого ролика.
    langWaitForId: null,
    // Идёт опрос /meta_local для этого ролика (запланирован следующий заход).
    // Пока он есть, «язык не определён» показывать рано: поздний ретрай через
    // 25 с проходит бот-гейт, и перевод стартует сам.
    metaPending: null,
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
    // Что мост фактически отдал звуком для этого ролика (GET /source):
    // {role, lang, itag, dubStripped}. Пусто, пока аудио-задача не завершилась.
    src: null,
    // Сколько опросов сделано для текущего ролика: по нему растёт пауза, когда
    // сервер не прислал подсказку remaining (иначе спали бы опросы подряд).
    polls: 0,
    // Стагнация remaining: у роликов без речи (трейлеры, музыка) Яндекс
    // отвечает status=2, rem=5 и больше не двигается. Без счётчика поллинг
    // шёл бы вечно каждые 5 с.
    lastRem: -2,
    stall: 0,
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

  // Надёжный сигнал о дорожке может прийти до первого тика watch watcher.
  // Держим его по videoId до инициализации состояния конкретного ролика.
  var earlyAudioTrack = null;
  // Язык из player-ответа тоже приходит раньше, чем watcher переключит ролик.
  var earlyMetaLang = null;
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
  // Единая «витрина»: все этапы перевода, ошибки, готовность и короткие тосты
  // показываются в ОДНОМ окне фиксированного размера (раньше было два окна —
  // #vot-status и #vot-toast — и ширина/высота «плавали» по тексту).
  // Видимость: этапы «в пути» и ошибки — всегда; готовность и справочные строки
  // — только пока на экране элементы управления плеера, и гаснут сами после
  // запуска перевода.
  var ST_W = 480, ST_H = 100;
  var barEl = null, barFill = null, barTimer = null, barStart = 0, barRem = 0;
  var stText = '', stColor = '#90a4ae', stProg = null;
  var stKind = 'idle';               // busy | error | done | idle
  var stToastMsg = '', stToastUntil = 0, stToastTimer = null;
  var stShown = false, stGatePrev = -1, gateWhy = '-';
  var stSticky = false;              // сообщение требует действия — видно всегда

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
      s.lineHeight = '1.35';
      s.width = ST_W + 'px';
      s.height = ST_H + 'px';
      s.boxSizing = 'border-box';
      s.overflow = 'hidden';
      s.pointerEvents = 'none';
      s.whiteSpace = 'pre-wrap';
      s.wordBreak = 'break-word';
      s.display = 'none';
      // Шкала ожидания перевода живёт отдельным узлом: textContent у контейнера
      // стёр бы её, поэтому текст пишем в дочерний <div>. Высота текста выбрана
      // так, чтобы окно было одного размера: 20px паддингов + 68px текста
      // (3 строки) + 12px шкалы = ровно ST_H.
      var txt = document.createElement('div');
      txt.id = 'vot-status-text';
      txt.textContent = '';
      var tx = txt.style;
      tx.height = '68px';
      tx.overflow = 'hidden';
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
  // null/undefined (шкалу прячем — перевод готов/ошибка).
  function barApply(prog, visible) {
    if (!barEl) return;
    if (!visible || prog === undefined || prog === null || prog === false) {
      if (barTimer) { clearTimeout(barTimer); barTimer = null; }
      barStart = 0;
      barRem = 0;
      if (barEl.style.display !== 'none') barEl.style.display = 'none';
      return;
    }
    if (!barStart) barStart = Date.now();
    barRem = (typeof prog === 'number' && isFinite(prog) && prog > 0) ? prog : 0;
    if (barEl.style.display !== 'block') barEl.style.display = 'block';
    if (!barTimer) barTimer = setTimeout(barTick, 0);
  }

  // Видны ли сейчас элементы управления плеера (бар). Пилюля «готово» и
  // справочные строки не должны висеть поверх видео, когда бар скрыт.
  // Важно: `ytlr-player-actions-container` остаётся в DOM и на главной
  // (скрытый плеер предыдущего ролика), поэтому мало найти узел — нужен
  // полноэкранный <video> и попадание ряда в видимую область.
  function playerControlsVisible() {
    try {
      var v = null;
      try { v = findVideo(); } catch (e0) { v = null; }
      if (!v) { gateWhy = 'novid'; return false; }
      var vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
      var vr = v.getBoundingClientRect();
      if (!(vr.width >= vw * 0.5 && vr.height >= vh * 0.5)) { gateWhy = 'vsize'; return false; }
      var el = document.querySelector('ytlr-player-actions-container');
      if (!el) { gateWhy = 'norow'; return false; }
      var r = el.getBoundingClientRect();
      if (!(r.width > 1 && r.height > 1)) { gateWhy = 'rect0'; return false; }
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) { gateWhy = 'offscreen'; return false; }
      var n = el, op = 1, i = 0;
      while (n && n.nodeType === 1 && i < 8) {
        var cs = null;
        try { cs = window.getComputedStyle ? getComputedStyle(n) : null; } catch (e1) { cs = null; }
        if (cs) {
          if (cs.visibility === 'hidden') { gateWhy = 'vis'; return false; }
          var o = parseFloat(cs.opacity);
          if (isFinite(o) && o < op) op = o;
        }
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') { gateWhy = 'aria'; return false; }
        n = n.parentNode;
        i++;
      }
      if (!(op > 0.05)) { gateWhy = 'op' + op.toFixed(2); return false; }
      gateWhy = 'ok';
      return true;
    } catch (e2) { gateWhy = 'err'; return false; }
  }

  // Перерисовка витрины: решает, ЧТО показывать (тост важнее этапа) и НАДО ли
  // показывать окно вообще.
  function statusApply() {
    try {
      var el = ensureStatus();
      if (!el) return;
      var now = Date.now(), msg, color, prog = null, show = false;
      if (stToastMsg && now < stToastUntil) {
        msg = stToastMsg; color = '#ffb300';
        show = true;
      } else {
        msg = stText; color = stColor; prog = stProg;
        if (msg) {
          // busy/error/sticky — всегда; «готово» и справочные строки — только
          // вместе с баром плеера (после запуска перевода окно не висит).
          if (stKind === 'busy' || stKind === 'error' || stSticky) show = true;
          else show = playerControlsVisible();
        }
      }
      if (stToastMsg && !(now < stToastUntil)) {
        stToastMsg = '';
        if (stToastTimer) { clearTimeout(stToastTimer); stToastTimer = null; }
      }
      if (msg) {
        var txt = el.firstChild;
        if (txt && txt.nodeType === 1) {
          if (txt.textContent !== msg) txt.textContent = msg;
        } else if (el.textContent !== msg) el.textContent = msg;
        var bl = '4px solid ' + color;
        if (el.style.borderLeft !== bl) el.style.borderLeft = bl;
      }
      barApply(prog, show);
      var disp = show ? 'block' : 'none';
      if (el.style.display !== disp) el.style.display = disp;
      stShown = show;
      // Диагностика гейта — одна строка на смену состояния (для логов на ТВ).
      var g = show ? 1 : 0;
      if (g !== stGatePrev) {
        stGatePrev = g;
        log('st gate show=' + g + ' kind=' + stKind + ' toast=' + (stToastMsg ? 1 : 0)
          + (stSticky ? ' sticky=1' : '') + ' why=' + gateWhy);
      }
    } catch (e) { }
  }

  // Короткие уведомления (раньше — отдельное окно #vot-toast) идут в ту же
  // витрину и перекрывают текущий этап на время показа.
  function statusToast(m, ms) {
    var dur = ms || 3800;
    stToastMsg = String(m || '');
    stToastUntil = Date.now() + dur;
    if (stToastTimer) clearTimeout(stToastTimer);
    stToastTimer = setTimeout(function () {
      stToastTimer = null;
      if (Date.now() >= stToastUntil) { stToastMsg = ''; statusApply(); }
    }, dur + 40);
    statusApply();
  }

  // vot_ui.js (загружается раньше) делегирует сюда свои тосты.
  try { window.VOT_STATUS_TOAST = statusToast; } catch (eST) { }

  // Фоновый тик (из основного интервала): показывает/прячет окно вслед за
  // элементами управления плеера.
  function statusTick() {
    if (!stText && !stToastMsg) return;
    // busy/error/sticky видны всегда — пересчитывать гейт незачем.
    if (stKind === 'busy' || stKind === 'error' || stSticky) return;
    statusApply();
  }

  // sticky=true — сообщение требует действия пользователя (например, «язык не
  // определён: включите перевод кнопкой 文A»), поэтому оно видно и без бара
  // плеера: иначе подсказка появляется только вместе с элементами управления.
  function setStatus(text, color, prog, sticky) {
    try { state.uiStatus = String(text || ''); } catch (e0) { }
    stText = String(text || '');
    stColor = color || '#90a4ae';
    stProg = (prog === undefined) ? null : prog;
    stSticky = !!sticky;
    if (!stText) {
      stKind = 'idle';
    } else if (stColor === '#e53935') {
      stKind = 'error';
    } else if (stColor === '#4caf50') {
      stKind = 'done';
    } else if (stColor === '#f5a623') {
      stKind = 'busy';
    } else {
      stKind = 'idle';
    }
    statusApply();
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

  // Serverless-путь для status=6: мост сам достаёт аудио-URL у InnerTube
  // (ANDROID_VR / ANDROID / VISIONOS отдают прямой googlevideo-URL, которому не
  // нужны ни poToken, ни "n"), качает дорожку ЦЕЛИКОМ по Range и отдаёт её
  // Яндексу кусками по 5 295 308 Б. Это фоновый поток моста: видео не
  // ускоряется, не встаёт на паузу и вообще не трогается — страница лишь
  // опрашивает /audiosrc/status и рисует проценты.
  function bridgeAudioSrc(id, dur, tid) {
    if (!tid) { state.busy = false; setStatus('Перевод: нет translationId для аудио', '#e53935'); return false; }
    if (state.uploading) return true;
    if (state.audioUploaded) return false;
    state.uploading = true;
    state.pageRelay = false;
    state.srcTries = 0;
    state.translationId = String(tid);
    log('audiosrc id=' + id + ' tid=' + tid);
    setStatus('Перевод: качаю звук ролика в фоне…', '#f5a623', 'wait');
    // Мост спросит InnerTube сам, но на этом ТВ клиенты всё чаще отдают
    // LOGIN_REQUIRED. Свой подписанный URL у нас уже есть — его плеер
    // использует прямо сейчас, поэтому отдаём его мосту вместе с нашим UA.
    postAudioSrc(id, dur, tid, 12);
    return true;
  }

  // Ждём до ~6 с появления аудио-URL в плеере (на старте ролика он появляется
  // через 1–3 с), потом всё равно стартуем: пусть мост попробует сам.
  function postAudioSrc(id, dur, tid, tries) {
    if (state.curId !== id) { state.uploading = false; return; }
    var ps = null;
    try { ps = (window.__votAudioSrc && window.__votAudioSrc()) || null; } catch (e) { }
    if (!ps && tries > 0) { setTimeout(function () { postAudioSrc(id, dur, tid, tries - 1); }, 500); return; }
    var body = { videoId: id, translationId: String(tid), videoUrl: watchUrl(id) };
    if (dur > 0) body.duration = Number(dur);
    var vd = '';
    try { vd = (window.__votVisitorData && window.__votVisitorData()) || ''; } catch (e) { }
    if (vd) { body.visitorData = vd; log('audiosrc visitor len=' + vd.length); }
    if (ps && ps.url && ps.clen > 0) {
      body.srcUrl = ps.url;
      body.srcItag = ps.itag;
      body.srcClen = ps.clen;
      body.srcUa = String((window.navigator && navigator.userAgent) || '');
      log('audiosrc page url itag=' + ps.itag + ' clen=' + ps.clen + ' age=' + ps.age);
    } else {
      log('audiosrc no page url, trying innertube');
    }
    http('POST', '/audiosrc', body,
      function () { pollSrc(id, dur, Date.now()); },
      function (e) {
        state.uploading = false;
        state.busy = false;
        log('audiosrc start ERR ' + e);
        if (state.curId !== id) return;
        setStatus('Перевод: звук не отправился, жду сервер…', '#f5a623', 'wait');
        holdSix(id, dur, {}, 'audiosrc-failed');
      });
  }

  var SRC_POLL_MS = 700;       // шаг опроса статуса: 4 обновления в секунду хватает
  var SRC_MAX_MS = 900000;     // 15 мин: дольше ждать бессмысленно

  function pollSrc(id, dur, t0) {
    if (state.curId !== id) { state.uploading = false; return; }
    if (Date.now() - t0 > SRC_MAX_MS) {
      state.uploading = false;
      state.busy = false;
      log('audiosrc timeout');
      holdSix(id, dur, {}, 'audiosrc-timeout');
      return;
    }
    http('GET', '/audiosrc/status', null, function (s) {
      if (state.curId !== id) { state.uploading = false; return; }
      var st = String((s && s.state) || '');
      if (st === 'done') {
        state.uploading = false;
        state.audioUploaded = true;
        state.busy = false;
        log('audiosrc ok client=' + (s.client || '?') + ' itag=' + (s.itag || '?')
          + ' size=' + (s.size || 0) + ' chunks=' + (s.chunks || 0) + ' ms=' + (s.ms || 0));
        setStatus('Перевод: звук загружен ('
          + Math.round(Number(s.size || 0) / 1024) + ' КБ), жду перевод…', '#f5a623', 'wait');
        poll(id, dur, 5);
        return;
      }
      if (st === 'error') {
        // Мост мог стартовать на конфиге плеера от прошлого ролика и получить
        // sabr.malformed_config. Пара «wire url + поле 5» появляется через
        // пару секунд после старта воспроизведения — пробуем ещё раз.
        state.srcTries = Number(state.srcTries || 0) + 1;
        if (state.srcTries <= 3) {
          log('audiosrc ERR ' + (s && s.err) + ' retry ' + state.srcTries + '/3');
          setStatus('Перевод: звук не загрузился, пробую снова…', '#f5a623', 'wait');
          var tid = Number(state.translationId || 0);
          setTimeout(function () {
            if (state.curId === id && state.uploading) postAudioSrc(id, dur, tid, 0);
          }, 5000);
          return;
        }
        state.uploading = false;
        state.busy = false;
        state.pageRelay = false;
        log('audiosrc ERR ' + (s && s.err) + ' (no retries left)');
        if (state.curId !== id) return;
        setStatus('Перевод: звук не загрузился\n' + (s && s.err || ''), '#f5a623', 'wait');
        holdSix(id, dur, {}, 'audiosrc-failed');
        return;
      }
      // Мост не смог скачать дорожку сам (403 с пустым телом на этом ролике) и
      // отдал подписанный url нам: страница качает те же байты своим сетевым
      // стеком — тем самым, которым играет плеер.
      if (st === 'need_page') {
        if (!state.pageRelay) {
          state.pageRelay = true;
          log('audiosrc need_page why=' + (s && s.err));
          pageRelay(id, dur, s, t0);
        }
        return;
      }
      var got = Number(s && s.bytes || 0);
      var tot = Number(s && s.total || 0);
      var ph = String((s && s.phase) || '');
      var part = Number(s && s.part || 0);
      var nparts = Number(s && s.chunks || 0);
      // `total` — объявленная длина аудиоформата из ответа player'а, а `bytes` —
      // сколько реально пришло из SABR: сегменты повторяются (ретраи, повторный
      // init), поэтому байт бывает больше объявленного («29350 / 24534 КБ»).
      // Процент и пару «скачано / всего» показываем только пока не перевалили;
      // дальше — одно число, иначе шкала выглядит сломанной.
      var over = tot > 0 && got > tot;
      var pct = tot > 0 ? Math.min(99, Math.round(got / Math.max(tot, got) * 100)) : 0;
      var head;
      if (ph === 'upload') head = 'отправляю звук в фоне ' + pct + '%';
      else if (ph === 'download' || got > 0) head = 'качаю звук в фоне ' + pct + '%';
      else head = 'ищу аудиопоток ролика…';
      // Номер части показываем только когда их правда несколько: на коротком
      // ролике «часть 1/1» в статусе выглядит как сбой.
      var sub = nparts > 1 && part > 0 ? ' (часть ' + Math.min(part, nparts) + '/' + nparts + ')' : '';
      var sizeText = '…';
      if (got > 0 && over) sizeText = Math.round(got / 1024) + ' КБ';
      else if (tot > 0) sizeText = Math.round(got / 1024) + ' / ' + Math.round(tot / 1024) + ' КБ';
      setStatus('Перевод: ' + head + sub + '\n' + sizeText, '#f5a623', 'wait');
      setTimeout(function () { pollSrc(id, dur, t0); }, SRC_POLL_MS);
    }, function (e) {
      log('audiosrc status ERR ' + e);
      setTimeout(function () { pollSrc(id, dur, t0); }, SRC_POLL_MS * 2);
    });
  }

  // ---- page relay: parts fetched by the page, uploaded by the bridge -------
  // Мост получил 403 на googlevideo (Java-стек ТВ заблокирован на конкретном
  // ролике), но страница тот же файл тянет плеером. Качаем части своим XHR,
  // постим байты в /audiosrc/raw — загрузка в Яндекс остаётся в мосту.
  var PAGE_PART = 5295308;     // ровно AUDIO_CHUNK_SIZE моста
  var PAGE_TRIES = 2;

  function pageRelay(id, dur, s, t0) {
    var url = String((s && s.url) || '');
    var clen = Number((s && s.clen) || 0);
    var total = Number((s && s.chunks) || 0);
    // У плеера может быть свой, более свежий подписанный URL того же трека.
    // Берём его, только если длина файла совпадает: иначе поедут границы
    // частей, а мост ждёт ровно `total` частей по 5 295 308 Б.
    try {
      var ps = (window.__votAudioSrc && window.__votAudioSrc()) || null;
      if (ps && ps.url && clen > 0 && Number(ps.clen) === clen) {
        url = ps.url;
        log('audiosrc page relay uses player url itag=' + ps.itag + ' age=' + ps.age);
      }
    } catch (e) { }
    if (!url || clen <= 0 || total <= 0) {
      state.uploading = false;
      state.pageRelay = false;
      state.busy = false;
      log('audiosrc page relay bad args clen=' + clen + ' parts=' + total);
      holdSix(id, dur, {}, 'page-relay-bad');
      return;
    }
    log('audiosrc page relay clen=' + clen + ' parts=' + total);
    var idx = 0;
    var bytes = 0;

    function fail(e) {
      state.pageRelay = false;
      state.uploading = false;
      state.busy = false;
      log('audiosrc page ERR ' + e);
      if (state.curId !== id) return;
      setStatus('Перевод: звук не скачался страницей\n' + e, '#e53935', 'wait');
      holdSix(id, dur, {}, 'page-fetch-failed');
    }

    function draw() {
      var pct = clen > 0 ? Math.min(99, Math.round(bytes / clen * 100)) : 0;
      setStatus('Перевод: качаю звук в фоне ' + pct + '% (часть '
        + Math.min(idx + 1, total) + '/' + total + ')\n'
        + Math.round(bytes / 1024) + ' / ' + Math.round(clen / 1024) + ' КБ',
        '#f5a623', 'wait');
    }

    // Один диапазон файла. 206 — норма, а вот 200 значит, что Range проигнорирован
    // и пришёл весь файл: вырезаем нужное окно сами, иначе части поедут.
    function grab(from, to, tries, ok) {
      var want = to - from + 1;
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.responseType = 'arraybuffer';
      x.timeout = 180000;
      try { x.setRequestHeader('Range', 'bytes=' + from + '-' + to); } catch (e0) { }
      x.onload = function () {
        var buf = x.response;
        var len = buf ? buf.byteLength : 0;
        if (len === want) { ok(buf); return; }
        if (len > want) { try { ok(buf.slice(0, want)); return; } catch (e1) { } }
        if (tries > 1) { grab(from, to, tries - 1, ok); return; }
        fail(new Error('googlevideo http ' + x.status + ' len=' + len + '/' + want));
      };
      x.onerror = function () {
        if (tries > 1) { grab(from, to, tries - 1, ok); return; }
        fail(new Error('googlevideo network'));
      };
      x.ontimeout = function () { fail(new Error('googlevideo timeout')); };
      x.send();
    }

    function post(i, buf, ok) {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + '/audiosrc/raw?part=' + i, true);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.timeout = 180000;
      x.onload = function () {
        if (x.status === 200) { ok(); return; }
        var t = '';
        try { t = String(x.responseText || '').slice(0, 160); } catch (e2) { }
        fail(new Error('bridge http ' + x.status + (t ? ' ' + t : '')));
      };
      x.onerror = function () { fail(new Error('bridge network')); };
      x.ontimeout = function () { fail(new Error('bridge timeout')); };
      x.send(buf);
    }

    function next() {
      if (state.curId !== id) { state.pageRelay = false; state.uploading = false; return; }
      if (idx >= total) {
        state.pageRelay = false;
        setStatus('Перевод: звук отправлен, жду перевод…', '#f5a623', 'wait');
        pollSrc(id, dur, t0);
        return;
      }
      var from = idx * PAGE_PART;
      var to = Math.min(clen, from + PAGE_PART) - 1;
      draw();
      grab(from, to, PAGE_TRIES, function (buf) {
        if (state.curId !== id) { state.pageRelay = false; state.uploading = false; return; }
        post(idx, buf, function () {
          bytes += buf.byteLength;
          idx += 1;
          log('audiosrc page part ' + idx + '/' + total + ' bytes=' + bytes);
          draw();
          setTimeout(next, 0);
        });
      });
    }

    next();
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

  // Both shards are dead (or the task id is terminal): look in the other shard.
  // The box feeds Yandex itself (bridge audio job), so there is no LAN filler
  // left to escalate to.
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
    return false;
  }

  // Single response handler for both the first request and the polls.
  function handleResp(r, id, dur, fallbackRem) {
    // A poll scheduled for the previous video can land after the user switched:
    // acting on it would poison altLangTried/src/retried for the new video.
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
      log('status=6 dead (both shards empty, bridge audio failed)');
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
      setStatus('Перевод выключен\nвключить: кнопка 文A в баре', '#90a4ae');
      return;
    }
    // Решение о языке — по TrackDecision (источник + достоверность). Ручная
    // кнопка/пункт меню (forceTranslate) правило обходят: человек уже сказал
    // «переводить», поэтому при неизвестном языке уходим в автоопределение.
    var d = trackDecision(id);
    var skip = (state.forceTranslate === id) ? '' : langBase(uiPref('skipLang', 'ru'));
    // Дубль (в т.ч. автодуб) — это НЕ язык оригинала: по нему нельзя ни
    // решить «ролик на моём языке», ни выбрать шард Яндекса. Такой случай
    // обрабатываем как «язык оригинала неизвестен».
    var dubRole = (d.role === 'AUTODUB' || d.role === 'DUB');
    if (!skip) {
      if (!d.language || dubRole) lang = 'auto';
    } else if (d.confidence === 'NONE' || !d.language || dubRole) {
      // Язык неизвестен — это НЕ повод переводить русский ролик вслепую и не
      // повод бросать иностранный. unknownPolicy:
      //   hold — ждём подтверждённый язык (по умолчанию);
      //   ask  — то же, но 文A/пункт меню переводят с автоопределением;
      //   auto — явный переключатель: переводим с lang:"auto" сразу.
      var pol = String(uiPref('unknownPolicy', 'hold') || 'hold');
      if (pol === 'auto') {
        log('translate: lang unknown (source=' + d.source + ') -> auto per policy id=' + id);
        lang = 'auto';
      } else {
        var mt = metaTries || 0;
        if (mt < 1) {
          log('translate waiting for source lang try=' + (mt + 1) + ' id=' + id);
          setTimeout(function () {
            if (state.curId === id) startTranslation(id, dur, lang, mt + 1);
          }, 500);
          return;
        }
        // Кириллический title, субтитры и шард Яндекса не доказывают язык звука.
        // Держим автостарт, но не ставим skipLangBlock: если язык придёт позже,
        // maybeSkipNow запустит перевод иностранного ролика автоматически.
        state.busy = false;
        state.langWaitForId = id;
        if (state.metaPending === id) {
          // Мета ещё опрашивается (после бот-гейта заход повторяется через
          // 25 с и обычно проходит). «Не определён» в этот момент — ложь:
          // язык придёт, и перевод стартует сам. Держим окно ожидания; OK,
          // как и раньше, форсирует перевод немедленно.
          log('translate wait: lang pending (source=' + d.source + ') id=' + id);
          langWaitStatus(id);
        } else {
          log('translate hold: source lang unknown (source=' + d.source + ') id=' + id);
          setStatus(langHoldText(), '#90a4ae', null, 1);
        }
        schedulePaint();
        return;
      }
    } else if (d.playingRussian) {
      // «Ролик на вашем языке» без подтверждённой дорожки — только подсказка:
      // у автодублированных роликов defaultAudioLanguage описывает ДУБЛЬ, а
      // играем мы оригинал. Такой «ru» уже ошибочно отменял перевод
      // иностранного ролика, поэтому спрашиваем, а не молчим.
      if (!skipTrusted(d)) {
        state.busy = false;
        state.langWaitForId = id;
        log('translate hold: lang=' + d.language + ' unconfirmed (' + d.confidence
          + '/' + d.source + '/' + String(state.origLangFrom || '-') + ') id=' + id);
        setStatus('Перевод: похоже, звук на русском\nнажмите OK — всё равно перевести', '#90a4ae', null, 1);
        schedulePaint();
        return;
      }
      state.busy = false;
      log('translate skipped: ' + d.source + ' lang=' + d.language
        + ' = skipLang (' + d.confidence + ') id=' + id);
      setStatus('Перевод: ролик на вашем языке «' + langLabel(d.language) + '»\n(перевод не нужен)', '#90a4ae');
      return;
    }
    state.busy = true;
    // Язык запроса = язык оригинала, когда он известен: Яндекс ключует кэш
    // перевода по нему. 'auto' остаётся только явным выбором, а выбранный шард
    // (shard=en) — ручной настройкой.
    state.lang = (lang === 'auto') ? 'auto'
      : (d.language || ((lang && lang !== 'auto') ? lang
        : (uiPref('shard', 'auto') === 'en' ? 'en' : (state.lang || 'en'))));
    state.title = (typeof document.title === 'string') ? document.title : '';
    setStatus('Перевод: отправляю запрос…\nvideo=' + id + ' · ' + Math.round(dur) + 'с', '#f5a623');
    log('translate start id=' + id + ' ts=' + Date.now()
      + ' dur=' + dur.toFixed(1) + ' lang=' + state.lang
      + ' title=' + String(state.title || '').slice(0, 40));
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
    // Стагнация (только для обычного status=2). status=6 (holdMs) живёт по
    // своим правилам: там сервер сам тянет звук, и rem врёт.
    if (holdMs > 0) {
      state.lastRem = -2;
      state.stall = 0;
    } else if (rem > 0 && rem === state.lastRem) {
      state.stall = (state.stall || 0) + 1;
    } else {
      state.stall = 0;
    }
    if (holdMs <= 0) state.lastRem = rem;
    if (holdMs <= 0 && state.stall >= STALL_LIMIT) {
      state.busy = false;
      setStatus('Перевод: сервер не смог обработать звук\nпохоже, в ролике нет речи', '#e53935', 0, true);
      log('poll stall ' + state.stall + ' rem=' + rem + ' — stop');
      return;
    }
    var stalled = (holdMs <= 0 && state.stall >= STALL_SOFT);
    var delay;
    if (holdMs > 0) {
      // status=6: сервер сам тянет звук. Пауза фиксированная и длинная, чтобы
      // не долбить /translate, и не зависит от rem (он там врёт: 57 → 1 через
      // считанные минуты).
      delay = holdMs;
    } else if (stalled) {
      // rem не двигается: job на сервере либо уже мёртв, либо очень долгий.
      // Опрашиваем редко, чтобы не жечь запросы, но не бросаем сразу —
      // такие переводы иногда всё-таки доготовляются.
      delay = STALL_DELAY;
    } else if (rem < 0) {
      delay = (state.polls <= POLL_FAST_TRIES)
        ? POLL_NO_HINT
        : Math.min(POLL_SLOW * (state.polls - POLL_FAST_TRIES), POLL_SLOW_MAX);
    } else {
      // The server hint ("rem=71") is very conservative: in practice the
      // translation shows up much sooner, so never sleep longer than POLL_MAX.
      delay = Math.min(Math.max(POLL_BASE, rem * 1000), POLL_MAX);
    }
    setStatus((stalled
      ? 'Перевод: сервер обрабатывает звук дольше обычного…'
      : (holdMs > 0
        ? 'Перевод: сервер готовит звук…'
        : (state.active ? 'Перевод: играю, доготовится…' : 'Перевод: в очереди/переводится…'))) +
      (rem > 0 && !stalled ? ' (~' + rem + 'с)' : ''), '#f5a623', rem > 0 && !stalled ? rem : 'wait');
    log('poll in ' + (delay / 1000).toFixed(0) + 's rem=' + rem + ' n=' + state.polls + (stalled ? ' stall=' + state.stall : ''));
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

  // Дополнительная защита для уже запрошенного перевода: готовый звук из кэша
  // Яндекса нельзя включать при неизвестном или исключённом языке дорожки.
  function gateReady(id, url, partial) {
    if (state.curId !== id || state.skipLangBlock === id || state.offForId === id
        || uiPref('translate.enabled', true) === false) return;
    var forced = state.forceTranslate === id;
    var d0 = trackDecision(id);
    if (!forced && d0.playingRussian) {
      log('lang gate: ' + d0.source + ' lang=' + d0.language + ' excluded -> no audio id=' + id);
      return;
    }
    // Язык известен (даже приблизительно) — решаем сразу. MEDIUM не повод
    // держать готовый звук: неизвестность не должна съедать перевод навсегда.
    // Исключение — дубль: его язык не описывает оригинал.
    var dubRole = (d0.role === 'AUTODUB' || d0.role === 'DUB');
    if (forced || (d0.confidence !== 'NONE' && !dubRole)) {
      if (partial) onPartial(url); else onReady(url);
      return;
    }
    var pol = String(uiPref('unknownPolicy', 'hold') || 'hold');
    if (pol === 'auto') {
      log('lang gate: lang unknown -> play (policy=auto) id=' + id);
      if (partial) onPartial(url); else onReady(url);
      return;
    }
    var gateMs = Number((state.cfg && state.cfg.langGateMs) || LANG_GATE_MS);
    if (!(gateMs > 0)) gateMs = LANG_GATE_MS;
    state.gate = { id: id, url: url, partial: !!partial, until: Date.now() + gateMs };
    setStatus('Перевод: готов, проверяю язык ролика…', '#f5a623', 'wait');
    log('lang gate wait id=' + id + ' url=' + String(url).slice(0, 40) +
      ' max=' + Math.round(gateMs) + 'ms policy=' + pol);

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
      if (state.forceTranslate === id) { deliver(g); return; }
      var d = trackDecision(id);
      if (d.playingRussian) {
        state.gate = null;
        log('lang gate: ' + d.source + ' lang=' + d.language + ' excluded -> no audio id=' + id);
        return;
      }
      if (d.confidence !== 'NONE' && d.role !== 'AUTODUB' && d.role !== 'DUB') {
        log('lang gate: lang=' + d.language + ' (' + d.source + '/' + d.confidence + ') -> play');
        deliver(g);
        return;
      }
      if (Date.now() >= g.until) {
        // Не теряем готовый URL: поздний подтверждённый язык либо ручная 文A
        // должны включить ЭТОТ звук, а не отправлять /translate повторно.
        state.langWaitForId = id;
        log('lang gate: lang unknown (' + d.source + ') -> hold id=' + id);
        setStatus(pol === 'ask'
          ? 'Перевод: язык звука не определён\nнажмите OK — перевести (авто)'
          : 'Перевод: язык звука не определён\nнажмите OK — включить перевод', '#90a4ae', null, 1);
        schedulePaint();
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
        ' audio=' + (c.audioMode || 'off') + ' lang=' + state.lang);
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
        earlyAudioTrack = null;
        earlyMetaLang = null;
        state.busy = false;
        state.langWaitForId = null;
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
    state.origLangFrom = '';
    state.langWaitForId = null;
    // Язык звучащей дорожки относится к ролику так же, как и язык оригинала.
    state.audioLang = '';
    state.audioAcont = '';
    state.audioDubbed = false;
    state.audioTrackId = '';
    state.audioMapped = false;
    // Выбор озвучки (автодуб или Яндекс) действует только на свой ролик.
    state.dubOffer = null;
    state.dubPick = null;
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
    state.pageRelay = false;
    state.retried = false;
    state.src = null;
    state.capTried = false;
    state.capBusy = false;
    state.capFailed = false;
    state.capTries = 0;
    state.capSentSize = 0;
    state.sixSince = 0;
    state.sixWaits = 0;
    state.polls = 0;
    state.lastRem = -2;
    state.stall = 0;
    state.metaLate = null;
    state.metaLateN = 0;
    state.metaPending = null;
    state.livelyVoice = false;
    state.playedOnce = false;
    state.restarting = false;
    state.lastSeek = 0;
    http('POST', '/stop', { }, function () { }, function () { });
    setStatus('Перевод: видео найдено, жду плеер…\nvideo=' + id, '#90a4ae');
    log('watch detected id=' + id);
    // После полного сброса применяем только подтверждённую дорожку этого id.
    var early = earlyAudioTrack;
    earlyAudioTrack = null;
    if (early && early.id === id) window.__votAudioTrack(early.ti, id);
    // Язык из ответа плеера, пришедший до переключения watcher.
    var em = earlyMetaLang;
    earlyMetaLang = null;
    if (em && em.id === id) window.__votMetaLang(em.id, em.lang, em.src);
    // Ряд кнопок перерисовывается под новый ролик: подсветку ставим сразу,
    // не дожидаясь тика (иначе кнопка на секунду гаснет).
    try { schedulePaint(); } catch (ep) { }
    fetchMeta(id);
    var tries = 0;
    var cfgWait = 0;
    (function wait() {
      var v = findVideo();
      // Без конфига моста неизвестно, включён ли захват (audioMode): даём ему
      // до 10 с, но не блокируем запуск навсегда.
      if (v && v.duration > 0 && !state.cfg && cfgWait++ < 20) {
        setTimeout(wait, 500);
        return;
      }
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
    // Одно окно статуса: тост не открывает вторую плашку, а перекрывает этап.
    try { statusToast(m, ms); return; } catch (e) { }
    try { if (window.VOTUI) VOTUI.toast(m, ms); } catch (e2) { }
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

  // ---- TrackDecision: что известно о языке звука и насколько верить --------
  // Раньше смешивались две разные задачи: (1) с какого языка переводить и
  // (2) гарантия, что Cobalt играет оригинал. Здесь решается первая: собираем
  // всё, что реально известно о языке звучащей дорожки, с оценкой достоверности.
  // Источники по убыванию надёжности:
  //   user       — человек нажал 文A/выбрал пункт меню: спорить не с чем;
  //   source     — мост отдал /source: роль и язык дорожки, ушедшей в Яндекс;
  //   audioTrack — xtags из SABR-запроса (на ТВ JS их не видит: оставлено как
  //                источник на случай, если плеер когда-нибудь отдаст их);
  //   meta_local — подсказки player-ответа: MEDIUM, звук они не доказывают;
  //   none       — UNKNOWN: включается unknownPolicy (hold по умолчанию).
  // `audioIsDefault`/`defaultAudioTrackIndex` источником НЕ считаются: дефолтной
  // дорожкой может оказаться автодуб, подставленный под язык аккаунта.
  // Можно ли молча решить «ролик уже на вашем языке»? Только по сигналу о
  // реально звучащей дорожке (HIGH). Подсказка defaultAudioLanguage — это язык
  // ДУБЛЯ у автодублированных роликов, а играем мы оригинал.
  function skipTrusted(d) {
    if (!d) return false;
    if (d.confidence === 'HIGH') return true;
    if (d.source === 'meta_local' && (state.origLangFrom === 'defaultLanguage'
      || state.origLangFrom === 'vdlang')) return false;
    return true;
  }

  function trackDecision(id) {
    var skip = langBase(uiPref('skipLang', 'ru'));
    var d = {
      role: 'UNKNOWN', language: '', source: 'none', confidence: 'NONE',
      availableRussianDub: false, playingRussian: false, dubSuppressedByPolicy: false
    };
    var s = state.src;
    if (s && s.lang && s.role && s.role !== 'AUTODUB' && s.role !== 'DUB') {
      d.role = String(s.role);
      d.language = langBase(s.lang);
      // track — дорожка из SABR-запроса самого плеера (факт того, что звучит);
      // default — дорожка, объявленная в player-ответе дорожкой по умолчанию
      // (SABR-запрос на ТВ id не даёт); job — байты, которые мост отдал
      // плееру/Яндексу; page — только конфиг моста, то есть план, а не факт.
      d.source = s.phase === 'track' ? 'sabr-track'
        : s.phase === 'default' ? 'sabr-default'
        : s.phase === 'job' ? 'source' : 'bridged';
      // mapped=0 — id дорожки не нашёлся в player-ответе: язык известен, а
      // оригинал это или дубль — нет. Такому сигналу верим как MEDIUM.
      d.confidence = s.dubStripped ? 'MEDIUM'
        : (s.phase === 'page' || s.phase === 'default'
          || (s.phase === 'track' && s.mapped === 0)) ? 'MEDIUM' : 'HIGH';
    } else if (state.audioLang) {
      d.role = state.audioDubbed ? 'AUTODUB' : 'PLAIN';
      d.language = langBase(state.audioLang);
      // Дорожка из SABR-запроса самого плеера: это факт, а не подсказка.
      // mapped=true — id дорожки нашёлся в player-ответе, значит роль (дубль
      // или оригинал) подтверждена xtags. mapped=false — известен только id.
      d.source = state.audioMapped ? 'sabr-track' : 'audioTrack';
      d.confidence = state.audioDubbed ? 'LOW'
        : (state.audioMapped ? 'HIGH' : 'MEDIUM');
    } else if (state.origLang) {
      d.role = 'PLAIN';
      d.language = langBase(state.origLang);
      d.source = 'meta_local';
      d.confidence = 'MEDIUM';
    }
    if (s && s.dubStripped) {
      // Дубль существует, но SABR его не отдаёт (мост режет xtags, иначе сервер
      // отвечает policy-кадром). Предлагать «автодуб / Яндекс» в этом случае
      // нельзя: автодуба пользователь всё равно не услышит.
      d.dubSuppressedByPolicy = true;
      if (skip && langBase(s.lang) === skip) d.availableRussianDub = true;
    }
    if (skip && d.language && d.language === skip) d.playingRussian = true;
    if (state.forceTranslate === id) { d.source = 'user'; d.confidence = 'HIGH'; }
    return d;
  }

  // Ролик оказался на исключённом языке (по умолчанию русский) уже после старта
  // перевода: гасим звук перевода и блокируем повторный запуск для этого id.
  // `why` уточняет источник: язык оригинала или уже звучащая дорожка (автодуб).
  function maybeSkipNow(id, lang, why) {
    var skip = langBase(uiPref('skipLang', 'ru'));
    // Решает TrackDecision (учитывает /source, SABR-дорожку и метаданные);
    // аргумент остаётся запасным сигналом для только что пришедшего значения.
    var d = trackDecision(id);
    var heard = d.language || langBase(lang);
    var waiting = state.langWaitForId === id;
    // Явное нажатие 文A или выбор Яндекса в меню — не отменять поздними метаданными.
    if (state.forceTranslate === id) return;
    // «Похоже, на вашем языке» без подтверждённой дорожки: не блокируем перевод
    // молча, а спрашиваем OK (как при неизвестном языке).
    if (skip && heard === skip && !skipTrusted(d)) {
      if (state.skipLangBlock === id) return;
      log('skip unconfirmed: ' + (why || d.source) + ' lang=' + heard
        + ' (' + d.confidence + '/' + String(state.origLangFrom || '-') + ') id=' + id);
      state.busy = false;
      state.langWaitForId = id;
      setStatus('Перевод: похоже, звук на русском\nнажмите OK — всё равно перевести', '#90a4ae', null, 1);
      schedulePaint();
      return;
    }
    if (!skip || heard !== skip) {
      if (state.curId !== id || state.offForId === id || state.skipLangBlock === id
          || uiPref('translate.enabled', true) === false) return;
      var g = state.gate;
      if (g && g.id === id) {
        state.langWaitForId = null;
        state.gate = null;
        log('lang gate: late audio lang=' + heard + ' -> play id=' + id);
        gateReady(id, g.url, g.partial);
        return;
      }
      // Пока язык был неизвестен, запрос не отправляли. Продолжаем только
      // один раз, когда надёжный язык этого ролика придёт позднее.
      if (waiting && !state.busy && !state.active) {
        var v = findVideo();
        if (v && v.duration > 0 && isFinite(v.duration)) {
          state.langWaitForId = null;
          log('translate resume: audio lang=' + heard + ' id=' + id);
          startTranslation(id, v.duration, state.lang || '');
        }
      }
      return;
    }
    if (waiting) state.langWaitForId = null;
    if (state.skipLangBlock === id) return;
    // Перевод для этого ролика выключен (кнопка в баре / выключен глобально):
    // писать «перевод не нужен» в этом случае неверно — сообщение затирало
    // статус «Перевод выключен» (жалоба на ТВ 31.10). Блокировку запоминаем,
    // но молча: кнопка включения её снимет.
    if (uiPref('translate.enabled', true) === false || state.offForId === id) {
      state.skipLangBlock = id;
      log('skip (silent): lang=' + heard + ' translate off id=' + id);
      return;
    }
    state.skipLangBlock = id;
    var wasRunning = state.active || state.audioPaused || state.busy;
    log((wasRunning ? 'translate abort: ' : 'translate skip (late meta): ')
      + (why || 'source') + ' lang=' + heard + ' matches skipLang=' + skip + ' id=' + id);
    state.busy = false;
    state.pendingPlay = null;
    state.gate = null;
    if (wasRunning) stopAudio(true);
    setStatus('Перевод: ' + (why === 'audio track' ? 'звук уже на вашем языке «' : 'ролик на вашем языке «')
      + langLabel(heard) + '»\n(перевод не нужен)', '#90a4ae');
    schedulePaint();
  }

  // «Мой язык» — язык, на котором пользователь смотрит. Пусто/не задан —
  // наследуем прежнюю настройку skipLang (по умолчанию русский), поэтому
  // старые профили ведут себя как раньше.
  function prefLangCode() {
    var p = String(uiPref('prefLang', '') || '');
    if (!p) p = String(uiPref('skipLang', 'ru') || '');
    return langBase(p);
  }

  // Единая настройка языка: выбранный «мой язык» одновременно и язык-исключение
  // (с него не переводим). Держим skipLang в согласии, чтобы все существующие
  // проверки (maybeSkipNow/startTranslation) работали без правок.
  function setPrefLang(v) {
    var l = langBase(v);
    // Повтор того же значения (клиент переисполняет команды пунктов попапа при
    // перерисовке) не должен сбрасывать блокировки текущего ролика.
    if (uiPref('prefLang', '') === l && String(uiPref('skipLang', 'ru')) === l) return;
    uiSet('prefLang', l);
    uiSet('skipLang', l);
    state.skipLangBlock = null;
    state.dubOffer = null;
    state.dubPick = null;
    log('prefLang=' + l);
    // Настройку поменяли на ходу — переоцениваем уже звучащую дорожку тем же
    // правилом (дедуп в __votAudioTrack по state.audioLang уже не сработает).
    if (l && state.audioDubbed && state.audioLang === l && state.curId) {
      offerDubChoice(state.curId, l);
    }
  }

  // Короткая подпись выбранного варианта озвучки для меню/панели.
  function dubPickLabel() {
    if (state.dubPick === 'yandex') return 'перевод Яндекса';
    if (state.dubPick === 'dub') return 'автодубляж';
    if (state.dubOffer && state.dubOffer === state.curId) return 'выбрать: автодуб/Яндекс';
    return 'авто';
  }

  // Плеер отдал автодуб на «моём языке» (prefLang). Яндекс тут не обязателен —
  // звук уже понятен, но голос дубля обычно хуже синтеза, поэтому молча ничего
  // не решаем: показываем предложение и ждём выбора (меню перевода → «Озвучка»
  // либо кнопка 文A). Автоперевод на это время заблокирован.
  function offerDubChoice(id, lang) {
    if (state.dubPick || state.dubOffer === id) return;
    var d = trackDecision(id);
    if (d.dubSuppressedByPolicy) {
      // Дубль вырезан мостом (SABR отвечает дублям policy-кадром): предлагать
      // «автодуб / Яндекс» нельзя — автодуба пользователь всё равно не услышит.
      log('dub offer skipped: dub stripped by policy id=' + id + ' lang=' + lang);
      return;
    }
    state.dubOffer = id;
    state.skipLangBlock = id;
    state.busy = false;
    log('dub offer id=' + id + ' lang=' + lang + ' pref=' + prefLangCode());
    setStatus('Звук: автодубляж на языке «' + langLabel(lang) + '»\n'
      + 'выбор: автодуб или перевод Яндекса\n(меню перевода → «Озвучка»)', '#29b6f6');
    uiToast('Автодуб на языке «' + langLabel(lang) + '»: выбрать в меню 文A');
    schedulePaint();
  }

  // Выбор озвучки для текущего ролика:
  //   'yandex' — включить перевод Яндекса (обходит правила prefLang/skipLang);
  //   'dub'    — слушать автодуб как есть, перевод для ролика выключаем.
  function pickDub(v) {
    var id = state.curId;
    if (!id) { uiToast('Ролик не открыт'); return; }
    var val = String(v || '').toLowerCase();
    if (val !== 'dub' && val !== 'yandex') return;
    // Повтор того же выбора (клиент умеет переисполнять команды пунктов при
    // перерисовке попапа) ничего не меняет.
    if (state.dubPick === val) return;
    var vd = findVideo();
    state.dubPick = val;
    state.dubOffer = null;
    if (val === 'yandex') {
      state.skipLangBlock = null;
      state.offForId = null;
      state.forceTranslate = id;
      state.langWaitForId = null;
      uiSet('translate.enabled', true);
      log('dub pick yandex id=' + id);
      uiToast('Озвучка: перевод Яндекса');
      var held = state.gate;
      if (held && held.id === id) {
        state.gate = null;
        gateReady(id, held.url, held.partial);
      } else {
        state.busy = false;
        startTranslation(id, (vd && vd.duration) ? vd.duration : 0, state.lang || '');
      }
    } else {
      state.skipLangBlock = id;
      state.busy = false;
      state.langWaitForId = null;
      state.pendingPlay = null;
      state.gate = null;
      stopAudio(true);
      log('dub pick dub id=' + id);
      uiToast('Озвучка: автодубляж');
      setStatus('Звук: автодубляж\n(перевод для ролика выключен)', '#90a4ae');
    }
    try { paintToggleBtn(); } catch (e0) { }
    schedulePaint();
  }

  // Язык-исключение, пришедший из /config моста (сервисный рычаг): применяем
  // как обычную настройку, чтобы ручной выбор в меню работал так же.
  window.__votSetSkipLang = function (v) {
    try {
      var l = langBase(v);
      if (prefLangCode() === l) return;
      setPrefLang(l);
      log('skipLang set from config: ' + l);
    } catch (e) { }
  };

  // Ручной выбор озвучки, пришедший из /config моста (сервисный рычаг):
  // применяем как выбор в меню «Озвучка».
  window.__votPickDub = function (v) {
    try { pickDub(v); } catch (e) { }
  };

  // Язык звучащей дорожки из `xtags` (см. sabrTrackInfo в vot_net.js). Вызывается
  // на первом POST плеера, то есть раньше /meta_local и раньше, чем мы вообще
  // успеваем отправить звук в Яндекс: русский оригинал и русский автодуб
  // отсекаются сразу, без запроса перевода.
  window.__votAudioTrack = function (ti, vid) {
    try {
      if (!ti || !ti.lang) return;
      var id = vid || state.curId;
      if (!id) return;
      if (id !== state.curId) {
        // URL уже нового ролика, но watcher ещё не переключил state.curId.
        // Кэшируем только событие с совпадающим id из адреса watch.
        if (getVideoId() === id) earlyAudioTrack = { id: id, ti: ti };
        return;
      }
      var l = langBase(ti.lang);
      if (l === state.audioLang && !!ti.dubbed === state.audioDubbed
          && !!ti.mapped === state.audioMapped) return;
      // mapped=true: id дорожки из SABR-запроса плеера нашёлся в player-ответе,
      // значит известны роль и язык (xtags). mapped=false: известен только id
      // (`en-US.4`) — язык звука знаем, а оригинал это или дубль, нет.
      var mapped = ti.mapped !== undefined ? !!ti.mapped : true;
      state.audioLang = l;
      state.audioAcont = String(ti.acont || '');
      state.audioDubbed = !!ti.dubbed;
      state.audioMapped = mapped;
      state.audioTrackId = String(ti.trackId || '');
      log('audio track lang=' + l + ' acont=' + state.audioAcont
        + ' dubbed=' + (state.audioDubbed ? 1 : 0) + ' mapped=' + (mapped ? 1 : 0)
        + ' tid=' + (state.audioTrackId || '-') + ' id=' + id);
      var pref = prefLangCode();
      // Автодуб уже на «моём языке»: не переводим молча, а предлагаем выбор
      // (автодуб или Яндекс). Решение запоминается на ролик.
      if (state.audioDubbed && pref && l === pref) { offerDubChoice(id, l); return; }
      // Плеер переключился на дорожку без дубля — предложение снимаем: дальше
      // работает обычное правило «оригинал на моём языке не переводим».
      if (!state.audioDubbed && state.dubOffer === id) state.dubOffer = null;
      // Дорожка без дубля и с подтверждённой ролью — это язык оригинала:
      // решение «не переводить» принимаем сразу, не дожидаясь InnerTube.
      if (mapped && !state.audioDubbed && !state.origLang) state.origLang = l;
      // Язык, который реально звучит, исключён — переводить нечего.
      maybeSkipNow(id, l, state.audioDubbed ? 'audio track' : 'sabr track');
    } catch (e) { }
  };

  // «Язык не определён» — только когда опрос меты действительно исчерпан.
  function langHoldText() {
    var pol = String(uiPref('unknownPolicy', 'hold') || 'hold');
    return pol === 'ask'
      ? 'Перевод: язык звука не определён\nнажмите OK — перевести (авто)'
      : 'Перевод: язык звука не определён\nнажмите OK — включить перевод';
  }

  // Пока мета ещё в пути — окно ожидания вместо ложного HOLD. Sticky нужен,
  // чтобы OK на пульте сработал (holdPending), но текст не пугает «не определён».
  function langWaitStatus(id) {
    if (state.metaPending !== id) return false;
    setStatus('Перевод: определяю язык звука…\nOK — перевести сразу', '#90a4ae', null, 1);
    return true;
  }

  // Опрос закончился без языка: теперь HOLD честный, автостарта больше не будет
  // (кроме следующих редких ретраев, если они ещё запланированы).
  function showLangHold(id) {
    if (!id || state.curId !== id || state.origLang) return;
    if (state.langWaitForId !== id || state.forceTranslate === id) return;
    log('translate hold: source lang unknown id=' + id);
    setStatus(langHoldText(), '#90a4ae', null, 1);
    schedulePaint();
  }

  // Язык оригинала. Оба источника живут на самой приставке, ПК не нужен:
  //  1) GET /source — что мост фактически отдал звуком (role/acont/lang и флаг
  //     dubStripped). Это описание тех байтов, которые ушли в Яндекс, поэтому
  //     сигнал самый надёжный;
  //  2) GET /meta_local — язык из player-ответа (его может не быть: например
  //     playability LOGIN_REQUIRED или ролик без подсказки языка).
  // Опрос повторяется по META_GAPS: аудио-задача моста идёт параллельно с
  // первым /translate, так что /source поначалу пуст.
  function fetchMeta(id, tries) {
    var n = tries || 0;
    // Опрос начат: до первого ответа язык «не определён» ещё не факт —
    // startTranslation должен показать ожидание, а не HOLD.
    state.metaPending = id;
    http('GET', '/source?videoId=' + encodeURIComponent(id), null, function (j) {
      if (state.curId !== id) return;
      if (!j || !j.ok) { fetchMetaLocal(id, n); return; }
      var lang = langBase(j.lang);
      var role = String(j.role || 'PLAIN');
      var stripped = !!j.dubStripped;
      state.src = { role: role, lang: lang, itag: j.itag, dubStripped: stripped,
        phase: String(j.phase || ''), served: String(j.served || ''),
        mapped: (j.mapped === undefined ? -1 : Number(j.mapped)) };
      log('source id=' + id + ' role=' + role + ' lang=' + (lang || '-')
        + ' itag=' + j.itag + ' stripped=' + (stripped ? 1 : 0));
      // Дубль просил сам плеер, а мост его вырезал: язык из этой записи — язык
      // ДУБЛЯ, об оригинале она ничего не говорит. В таком случае идём дальше
      // за /meta_local, но факт запоминаем для панели/решений.
      if (stripped || role === 'AUTODUB' || role === 'DUB') { fetchMetaLocal(id, n); return; }
      if (!lang) { fetchMetaLocal(id, n); return; }
      state.metaPending = null;
      if (lang && lang !== state.origLang) {
        state.origLang = lang;
        maybeSkipNow(id, lang, 'source');
      }
    }, function () { fetchMetaLocal(id, n); });
  }

  function fetchMetaLocal(id, n, late) {
    // visitorData страницы: гейт «confirm you're not a bot» привязан к visitor
    // id, а страница под своим id спокойно стримит это же видео. Свой свежий
    // visitor мост получает через visitor_id и быстро попадает под гейт.
    var vd = '';
    try { vd = String(ytcfgGet('VISITOR_DATA', '') || ''); } catch (e0) { }
    http('GET', '/meta_local?videoId=' + encodeURIComponent(id)
      + (vd ? ('&visitorData=' + encodeURIComponent(vd)) : '')
      + (late ? '&retry=1&basic=1' : ''), null, function (j) {
      if (state.curId !== id) return;
      var lang = langBase((j && j.lang) || '');
      if (j && j.ok && lang) {
        state.metaPending = null;
        if (lang !== state.origLang) {
          state.origLang = lang;
          state.origLangFrom = String(j.langFrom || '');
          log('meta_local id=' + id + ' lang=' + lang + ' from=' + String(j.langFrom || 'audio')
            + ' ms=' + (j.ms || 0) + (late ? ' late' : '') + ' title=' + String(j.title || '').slice(0, 40));
          maybeSkipNow(id, lang, 'meta_local');
        }
        return;
      }
      var why = String((j && j.why) || '').slice(0, 60);
      if (late) {
        log('meta_local late fail ' + String((j && j.err) || 'no lang') + (why ? ' why=' + why : ''));
        // Бот-гейт привязан к частоте запросов и проходит сам. Пока ролик
        // играет и язык ещё неизвестен, продолжаем РЕДКИЕ попытки (45 с,
        // один-два клиента): так язык подхватится без действий пользователя,
        // а гейт не усугубляется, как при серии полных переборов.
        var hardLate = /LOGIN_REQUIRED|not a bot/i.test(String((j && j.err) || ''));
        if (hardLate && state.curId === id && !state.origLang
            && (state.metaLateN || 0) < 8) {
          state.metaLateN = (state.metaLateN || 0) + 1;
          state.metaPending = id;
          // Ретраи идут серией по 45 с, и нередко именно один из них проходит
          // бот-гейт (на `P541-Kmv-6Q` язык нашёлся на третьем заходе, через
          // ~90 с). Пока серия жива, «не определён» — всё ещё неправда:
          // держим ожидание, OK по-прежнему форсирует перевод (sticky).
          langWaitStatus(id);
          setTimeout(function () {
            if (state.curId !== id || state.origLang) return;
            log('meta_local late retry id=' + id + ' n=' + state.metaLateN);
            fetchMetaLocal(id, 0, true);
          }, 45000);
        } else {
          state.metaPending = null;
          showLangHold(id);
        }
        return;
      }
      if (n < META_GAPS.length) {
        log('meta_local fail ' + String((j && j.err) || 'no lang') + ' try=' + (n + 1)
          + (why ? ' why=' + why : ''));
        // Бот-гейт: повторять чаще бессмысленно и вредно — каждый заход
        // перебирает клиентов и только усугубляет пометку visitor'а. Гейт по
        // частоте проходит сам, поэтому оставляем одну позднюю попытку.
        var hard = /LOGIN_REQUIRED|not a bot/i.test(String((j && j.err) || ''));
        if (hard && n >= 1) {
          log('meta_local id=' + id + ' lang unknown (bot gate)');
          if (state.metaLate !== id) {
            state.metaLate = id;
            state.metaPending = id;
            setTimeout(function () {
              if (state.curId !== id || state.origLang) return;
              log('meta_local late retry id=' + id);
              fetchMetaLocal(id, 0, true);
            }, 25000);
          }
          return;
        }
        state.metaPending = id;
        setTimeout(function () { fetchMeta(id, n + 1); }, META_GAPS[n]);
      } else {
        state.metaPending = null;
        log('meta_local id=' + id + ' lang unknown (source+meta timeout)');
        showLangHold(id);
      }
    }, function (e) {
      if (state.curId !== id) return;
      if (n < META_GAPS.length) {
        state.metaPending = id;
        setTimeout(function () { fetchMeta(id, n + 1); }, META_GAPS[n]);
      } else {
        state.metaPending = null;
        log('meta_local ERR ' + (e && e.message));
        showLangHold(id);
      }
    });
  }

  // Только для будущего источника ПОДТВЕРЖДЁННОГО языка. Список дорожек из
  // player JSON (audtrk/defaultAudioTrackIndex) сюда больше не передаётся:
  // дефолтная дорожка не обязательно звучит и не обязательно оригинальная.
  window.__votMetaLang = function (vid, lang, src) {
    try {
      var id = String(vid || '');
      var l = langBase(lang);
      if (!id || !l) return;
      // Ответ плеера приходит раньше, чем watcher переключит state.curId:
      // запоминаем по id и применяем в watcher'е (как earlyAudioTrack).
      if (id !== state.curId) {
        if (getVideoId() === id) earlyMetaLang = { id: id, lang: l, src: src };
        return;
      }
      if (state.audioLang) return;
      if (state.origLang === l) return;
      var had = state.origLang;
      state.origLang = l;
      state.origLangFrom = String(src || 'player');
      log('origLang=' + l + ' from ' + (src || 'player') + ' (was ' + (had || '-')
        + ') id=' + id);
      maybeSkipNow(id, l, 'source');
    } catch (e) { log('metaLang ERR ' + (e && e.name)); }
  };

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
    var s = String((state.cfg && state.cfg.audioMode) || 'local');
    var m = s === 'capture' ? 'захват MSE' : s === 'off' ? 'мост: выкл' : 'мост: сам';
    return (o ? 'другой кэш' : 'только шард') + ' · ' + m;
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
      out.push(votItem({ title: 'Звук для Яндекса', sub: 'мост качает сам, ПК не нужен',
        icon: 'CLOUD_DONE' }));
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
      // «Мой язык» — на нём смотрю, с него не перевожу (и автодуб на нём даёт
      // выбор «автодуб / Яндекс», см. offerDubChoice).
      var sk = String(uiPref('prefLang', '') || uiPref('skipLang', 'ru') || '');
      for (i = 0; i < VOT_LANGS.length; i++) {
        out.push(votCheck(VOT_LANGS[i].label, 'prefLang', String(VOT_LANGS[i].value),
          sk === String(VOT_LANGS[i].value)));
      }
      return out;
    }
    if (lv === 'vot-dub') {
      var pick = String(state.dubPick || '');
      out.push(votCheck('Автодубляж (как есть)', 'dub', 'dub', pick === 'dub'));
      out.push(votCheck('Перевод Яндекса', 'dub', 'yandex', pick === 'yandex'));
      var dd = state.curId ? trackDecision(state.curId) : null;
      out.push(votItem({ title: 'Звучит сейчас',
        sub: dd
          ? ((dd.language ? langLabel(dd.language) : '?') + ' · ' + dd.role.toLowerCase()
            + ' · ' + dd.source + '/' + dd.confidence.toLowerCase())
          : '—' }));
      return out;
    }
    if (lv === 'vot-unknown') {
      // Политика «язык звука неизвестен». HOLD по умолчанию: русский ролик не
      // должен уехать в перевод из-за отсутствия метаданных, а иностранный —
      // потеряться. ASK/AUTO — осознанный выбор пользователя.
      var up = String(uiPref('unknownPolicy', 'hold') || 'hold');
      out.push(votCheck('Держать (по умолчанию)', 'unknownPolicy', 'hold', up === 'hold'));
      out.push(votCheck('Предлагать автоопределение', 'unknownPolicy', 'ask', up === 'ask'));
      out.push(votCheck('Переводить с автоопределением', 'unknownPolicy', 'auto', up === 'auto'));
      return out;
    }
    // корень
    out.push(votItem({ title: 'Перевод Яндекс', sub: on ? 'включён' : 'выключен',
      icon: 'TRANSLATE', second: on ? 'CHECK' : 'RADIO_BUTTON_UNCHECKED',
      action: VOT_TOGGLE_ACTION }));
    var cur = state.curId ? trackDecision(state.curId) : null;
    if (cur && cur.confidence === 'NONE' && state.curId) {
      // Язык звука не определён: единственный безопасный ручной путь — перевод
      // с автоопределением (Яндекс сам определит исходный язык).
      out.push(votItem({ title: 'Перевести с автоопределением',
        sub: 'язык звука не определён', action: 'VOT_AUTOLANG' }));
    }
    out.push(votNavItem('Источник перевода', votSrcText(), 'vot-src'));
    out.push(votNavItem('Шард запроса', String(uiPref('shard', 'auto')), 'vot-shard'));
    out.push(votNavItem('Озвучка', dubPickLabel(), 'vot-dub'));
    out.push(votNavItem('Громкость', votVolText(), 'vot-vol'));
    out.push(votNavItem('Мой язык', langLabel(prefLangCode()), 'vot-skip'));
    out.push(votNavItem('Если язык не определён', unknownPolicyLabel(), 'vot-unknown'));
    out.push(votItem({ title: 'Статус', sub: votStatusText() }));
    return out;
  }

  function unknownPolicyLabel() {
    var p = String(uiPref('unknownPolicy', 'hold') || 'hold');
    return p === 'auto' ? 'автоопределение' : p === 'ask' ? 'предлагать' : 'держать';
  }

  // Ручной перевод с автоопределением исходного языка (lang:"auto"). Это тот
  // самый пункт «Перевести с автоопределением»: политика ASK запускает его
  // кнопкой, AUTO_DETECT делает то же автоматически.
  function translateAuto() {
    var id = state.curId, v = findVideo();
    if (!id) { uiToast('Нет активного ролика'); return; }
    state.forceTranslate = id;
    state.skipLangBlock = null;
    state.offForId = null;
    state.langWaitForId = null;
    uiSet('translate.enabled', true);
    log('manual translate: auto-detect id=' + id);
    uiToast('Перевод: автоопределение языка');
    var held = state.gate;
    if (held && held.id === id) { state.gate = null; gateReady(id, held.url, held.partial); return; }
    state.busy = false;
    startTranslation(id, (v && v.duration) ? v.duration : 0, 'auto');
  }

  function votSet(rest) {
    var s = String(rest || ''), p = s.indexOf(':');
    if (p < 0) { log('vot set: bad ' + s.slice(0, 24)); return; }
    var k = s.slice(0, p), v = s.slice(p + 1);
    if (k === 'shard') { uiSet('shard', v); state.lang = v; }
    else if (k === 'otherShard.enabled') uiSet(k, v === '1');
    else if (k === 'vol.translate' || k === 'vol.original') { uiSet(k, Number(v) || 0); applyVolume(); }
    else if (k === 'skipLang' || k === 'prefLang') setPrefLang(v);
    else if (k === 'unknownPolicy') {
      var pol = String(v || 'hold');
      if (pol !== 'hold' && pol !== 'ask' && pol !== 'auto') pol = 'hold';
      uiSet(k, pol);
      // Смена политики не должна оставлять ролик в вечном ожидании: снимаем
      // удержание и даём шанс решить заново на текущем ролике.
      state.langWaitForId = null;
    }
    else if (k === 'dub') pickDub(v);
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
    // Старые fallback-команды не открывают отвергнутый DOM popup.
    if (s === VOT_ACTION || s.indexOf('VOT_NAV:') === 0) return true;
    if (s.indexOf('VOT_SET:') === 0) { votSet(s.slice(8)); return true; }
    if (s === 'VOT_AUTOLANG') { translateAuto(); return true; }
    return false;
  }

  // Ползунки громкости. Родного слайдера в ТВ-клиенте нет (в реестре только
  // compactLinkRenderer/setting*-рендереры), поэтому влево/вправо ловим сами:
  // срабатывает, только когда фокус стоит на строке «Громкость перевода» или
  // «Оригинал при переводе» — в остальных плашках стрелки работают как обычно.
  // Клиент рисует подписи из нашей команды ровно один раз, поэтому после
  // изменения уровня строку приходится перерисовывать вручную (votPaintValue).
  var volKeyLog = 0;
  // Диагностика «навигация умерла»: первые несколько стрелок влево/вправо
  // показываем, какой узел реально в фокусе и опознали ли мы его как наш слайдер.
  var navDiag = 0;

  // Какая из наших строк в фокусе. Подпись может лежать в aria-label (как у
  // кнопок плеера) или текстом в поддереве — проверяем и то, и другое.
  function volKeyOf(a) {
    if (!a || a.nodeType !== 1) return '';
    // body/html (и вообще полноэкранные контейнеры) содержат ВЕСЬ текст страницы,
    // включая наши собственные подписи и последний тост «Громкость перевода: N%»,
    // которые остаются в DOM навсегда. Раньше совпадение по такому агрегату
    // заставляло нас гасить LEFT/RIGHT при activeElement=body — то есть всегда,
    // после того как панель/тост хоть раз отрисовались, и пульт в плеере «умирал»
    // до перезапуска приложения. Опознаём строку только по её собственному тексту.
    if (a === document.body || a === document.documentElement) return '';
    try { if (a.closest && a.closest('#vot-ui-root')) return ''; } catch (e0) { }
    var al = '', tx = '';
    try { if (a.getAttribute) al = String(a.getAttribute('aria-label') || ''); } catch (e) { }
    try { tx = String(a.textContent || ''); } catch (e2) { }
    // У контейнера textContent — весь интерфейс (бар плеера, панель настроек).
    // Подпись строки короткая; длинный текст означает, что узел не строка.
    if (tx.length > 120) tx = '';
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
    // body всегда «на экране» и всегда 1200x800 — как признак видимой строки не годится.
    if (a === document.body || a === document.documentElement) return false;
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
      if (navDiag < 4) {
        navDiag++;
        log('nav key kc=' + kc + ' af='
          + (a ? (a.tagName || '?') + (a.id ? '#' + a.id : '')
            + ' cls=' + String(a.className || '').slice(0, 32) : '-')
          + ' vol=' + (key || '-'));
      }
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
      state.langWaitForId = null;
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
    state.langWaitForId = null;
    state.forceTranslate = id;
    state.wantOn = id;
    log('toggle: on id=' + id);
    try { paintToggleBtn(); } catch (e1) { }
    var held = state.gate;
    if (held && held.id === id) {
      state.gate = null;
      log('lang gate: manual -> play cached id=' + id);
      gateReady(id, held.url, held.partial);
    } else {
      state.busy = false;
      startTranslation(id, (v && v.duration) ? v.duration : 0, state.lang || '');
    }
    schedulePaint();
  }

  // HOLD «язык не определён» показывается, когда бара плеера на экране нет,
  // поэтому нажать 文A физически некуда. OK на пульте — тот же выключатель:
  // при langWaitForId isTranslateOn() уже false, значит toggleTranslate()
  // уйдёт в ветку «включить» и проставит forceTranslate. Перехватываем OK
  // только пока висит именно это окно (kind=idle + sticky), иначе сломаем
  // обычную паузу.
  // Фокус на кнопке бара плеера (или в нашей панели): OK принадлежит ей.
  // Раньше перехват HOLD съедал первое нажатие — с фокусом на «шестерёнке»
  // прожимáлась кнопка перевода, а нужная кнопка срабатывала со второго раза.
  // Важно: проверять именно интерактивный контрол, а не «что-то кроме body».
  // Когда бар скрыт, фокус уезжает на YTLR-WATCH-DEFAULT — это не контрол, и
  // OK там обязан форсировать перевод (иначе пропадёт весь смысл хоткея).
  var FOCUS_CTRL = [
    'ytlr-button', 'yt-button-container', 'button', '[role="button"]',
    '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]', 'a[href]',
    'input', 'select', 'textarea',
    'ytlr-player-actions-container', 'ytlr-menu-item', 'ytlr-playlist-item',
    'ytlr-toggle-button', 'ytlr-icon-button', 'ytlr-compact-link'
  ].join(',');

  function focusOwnsKey() {
    try {
      var a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) return false;
      if (a.id === 'vot-status') return false;
      if (!a.closest) return false;
      if (a.closest('#vot-ui-root')) return false;
      return !!a.closest(FOCUS_CTRL);
    } catch (e) { return false; }
  }

  function holdPending() {
    return !!(state.langWaitForId && state.langWaitForId === state.curId
      && stSticky && stKind === 'idle' && !focusOwnsKey());
  }
  document.addEventListener('keydown', function (e) {
    var kc = e.keyCode || e.which;
    if (kc !== 13 && kc !== 23) return;
    if (!holdPending()) return;
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    log('hotkey OK kc=' + kc + ' -> force translate');
    toggleTranslate();
  }, true);
  // F4 (Android KEYCODE_F4 = 134, DOM keyCode = 115) — тот же выключатель
  // для отладки с клавиатуры. На пульте его нет, поэтому основной путь — OK.
  window.addEventListener('keydown', function (e) {
    var kc = e.keyCode || e.which;
    if (kc !== 115 && kc !== 134) return;
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    log('hotkey F4 kc=' + kc + ' -> toggle');
    toggleTranslate();
  }, true);

  // Диагностика жалобы «в плеере не работают кнопки». Пишем первые 24 клавиши
  // в capture-фазе (до клиента) и в bubble-фазе (после его обработчиков):
  // если в bubble `prevented=1` — событие дошло и клиент его обработал сам,
  // если bubble-строки вообще нет — клиент (или его оверлей) остановил поток.
  var kdiag = 0;
  function keyDiag() {
    window.addEventListener('keydown', function (e) {
      if (kdiag >= 24) return;
      kdiag++;
      var a = document.activeElement;
      log('kdiag cap kc=' + e.keyCode + ' af=' + (a ? String(a.tagName || '?').slice(0, 20) : '-')
        + (a && a.className ? ' cls=' + String(a.className).slice(0, 24) : ''));
    }, true);
    window.addEventListener('keydown', function (e) {
      if (kdiag > 24) return;
      log('kdiag bub kc=' + e.keyCode + ' prevented=' + (e.defaultPrevented ? 1 : 0)
        + ' cancel=' + (e.cancelable ? 1 : 0));
    }, false);
  }

  function setupUI() {
    if (!window.VOTUI || !VOTUI.on) return;
    VOTUI.init();
    votSliderKeys();
    keyDiag();
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
    // v4: «мой язык» (prefLang). Раньше был только skipLang — переносим его
    // значение, чтобы меню сразу показывало выбранный язык.
    if (Number(uiPref('prefs.v', 1)) < 4) {
      if (!uiPref('prefLang', '')) uiSet('prefLang', langBase(uiPref('skipLang', 'ru')));
      uiSet('prefs.v', 4);
      log('prefs migrated to v4: prefLang=' + prefLangCode());
    }
    VOTUI.on('translate.toggle', function () { toggleTranslate(); });
    VOTUI.on('pref.vol.translate', applyVolume);
    VOTUI.on('pref.vol.original', applyVolume);
    log('ui ready v=' + String(VOTUI.version));
  }

  // Пассивная диагностика штатной строки поиска и native popup. Никаких
  // надписей, input.value, классов, URL, команд или содержимого запроса.
  var sortProbeLines = 0, sortProbeSeen = {};
  function sortProbeLog(code) {
    if (sortProbeLines >= 16 || sortProbeSeen[code]) return;
    sortProbeSeen[code] = true;
    sortProbeLines++;
    log('sortProbe ' + code);
  }
  function sortProbeRow() {
    if (!document.querySelectorAll) return null;
    try {
      var rows = document.querySelectorAll('yt-focus-container');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i], ch = row.children;
        if (ch.length !== 3) continue;
        var rects = [], valid = true;
        for (var j = 0; j < 3; j++) {
          // Старый kbdDescribe обрезал tagName до 18 символов: «...-CO» —
          // префикс имени обёртки, а не полный тег.
          if (String(ch[j].tagName).toUpperCase().indexOf('YT-KEYBOARD-KEY-CO') !== 0 ||
              !ch[j].querySelector('yt-keyboard-key[role="button"]')) { valid = false; break; }
          rects.push(ch[j].getBoundingClientRect());
        }
        if (!valid) continue;
        sortProbeLog('row-shape=3'); // три родные кнопки, без чтения надписей
        var w = window.innerWidth ||
          (document.documentElement && document.documentElement.clientWidth) || 1920;
        if (!rects[0].width || !rects[1].width || !rects[2].width ||
            rects[0].right > rects[1].left + 3 ||
            rects[1].right > rects[2].left + 3 ||
            rects[1].left - rects[0].right > w * 0.15 ||
            rects[2].left - rects[1].right > w * 0.15 ||
            Math.max(rects[0].top, rects[1].top, rects[2].top) -
              Math.min(rects[0].top, rects[1].top, rects[2].top) > 12) {
          sortProbeLog('row-shape-rejected');
          continue;
        }
        return row; // три кнопки одного ряда, без viewport-зон и текста
      }
    } catch (e) { }
    return null;
  }
  function sortProbeFocus(row) {
    var last = row.children[2], key = last.querySelector('yt-keyboard-key');
    var active = document.activeElement, focus = 'other';
    if (active === key || key && key.contains(active)) focus = 'key';
    else if (active === last || last.contains(active)) focus = 'wrapper';
    else if (active === row || row.contains(active)) focus = 'row';
    var attr = key && (key.hasAttribute('aria-selected') ? 1 : 0) +
      (key.hasAttribute('data-focused') ? 2 : 0);
    return 'focus=' + focus + ' mark=' + (attr || 0);
  }
  function sortProbePopup(cmd, method) {
    if (!cmd || !cmd.openPopupAction || cmd.__votOwn || !sortProbeRow()) return;
    try {
      var oa = cmd.openPopupAction, uid = String(oa.uniqueId || '');
      var kind = uid === 'playback-settings' ? 'playback' :
        /search|sort|filter/i.test(uid) ? 'searchish' : 'other';
      var pop = oa.popup, sec = pop && pop.overlaySectionRenderer;
      var ov = sec && sec.overlay, tp = ov && ov.overlayTwoPanelRenderer;
      var ap = tp && tp.actionPanel, pan = ap && ap.overlayPanelRenderer;
      var ct = pan && pan.content, lst = ct && ct.overlayPanelItemListRenderer;
      var items = lst && lst.items;
      sortProbeLog('popup method=' + method + ' kind=' + kind +
        ' list=' + (Array.isArray(items) ? 1 : 0) +
        ' n=' + (Array.isArray(items) ? Math.min(99, items.length) : 0));
    } catch (e) { sortProbeLog('popup unavailable'); }
  }
  function setupSearchSortProbe() {
    sortProbeLog('v=3'); // версия JS; подтверждение обновления bundle на ТВ
    var tries = 0, timer = setInterval(function () {
      var row = sortProbeRow();
      if (row) {
        var last = row.children[2], key = last.querySelector('yt-keyboard-key');
        sortProbeLog('row=3 ' + sortProbeFocus(row) +
          ' renderer=' + (key && 'renderer' in key ? 1 : 0) +
          ' command=' + (key && 'command' in key ? 1 : 0) +
          ' data=' + (key && 'data' in key ? 1 : 0));
      }
      if (++tries >= 600) clearInterval(timer);
    }, 2000);
    document.addEventListener('keydown', function (e) {
      if (e.keyCode !== 39) return;
      var row = sortProbeRow();
      if (!row) return;
      sortProbeLog('right before ' + sortProbeFocus(row));
      setTimeout(function () {
        var after = sortProbeRow();
        if (after) sortProbeLog('right after ' + sortProbeFocus(after));
      }, 0);
      // Ничего не предотвращаем: штатная навигация остаётся без изменений.
    }, true);
  }

  // ---- Фильтры поиска ------------------------------------------------------
  // Вложенная панель справа от клавиатуры: корень (4 группы + «Сброс») и
  // подменю значений (Left — назад). Панель живёт только вместе с видимой
  // клавиатурой и уезжает вместе с ней. Выдачу не трогаем: params запроса
  // правит сетевой слой (vot_net.js). Значения в префах VOTUI, сброс — вручную.
  function setupSearchFilters() {
    if (!window.VOTUI || !document.querySelectorAll || !document.body) return;
    var GROUPS = [
      { key: 'search.sort', title: 'Сортировка',
        items: ['По релевантности', 'По дате загрузки', 'По просмотрам', 'По рейтингу'] },
      { key: 'search.date', title: 'Дата загрузки',
        items: ['Любая', 'За час', 'Сегодня', 'За неделю', 'За месяц', 'За год'] },
      { key: 'search.type', title: 'Тип',
        items: ['Все', 'Видео', 'Каналы', 'Плейлисты', 'Фильмы'] },
      { key: 'search.duration', title: 'Длительность',
        items: ['Любая', 'Короткие', 'Длинные'] }
    ];
    var panel = null, pageRoot = null, pageSub = null, rows = [], items = [];
    var searchKey = null, lastLayout = '', lastDiag = '', statusHidden = false;
    var openGroup = -1, rerunAt = 0, hideTimer = 0;
    // Панель видна только вместе с клавиатурой; resultEl — карточка выдачи,
    // на которую уходим по Down с «Сброса».
    var resultEl = null;
    var suppressUntil = 0, chainDone = false, kbGoneSince = 0, lastKb = null;
    var lastNavLog = 0;
    // После ухода из панели в выдачу окно не показываем, пока фокус не вернётся
    // в клавиатуру или поле поиска.
    var awayToResults = false;
    var kbSeen = false;
    var enterFrom = null;
    // Быстрый сторож клавиатуры: окно стартует свою анимацию в том кадре, в
    // котором прозрачность клавиатуры ушла от 1 (гаснет) или от 0 (появляется),
    // а не на ближайшем такте скана (100 мс) — иначе окно отстаёт.
    var ancBox = null, kbOpPrev = 1, kbLeaving = false;
    // Белый маркер фокуса клавиши рисуется отдельным элементом/состоянием
    // приложения; пока фокус в окне, прячем его и возвращаем на Left.
    var ringEls = [], ringLogged = false;
    // Пока true — не перехватываем Down с нижнего ряда, чтобы снять нативное
    // поведение. Диагностический режим, затем снимается.
    // Нативное поведение снято (Down с клавиатуры → ytlr-playback-preview,
    // клавиатура гаснет opacity .3s) — перехват включён.
    var NATIVE_PROBE = false;

    function diag(code) {
      if (lastDiag === code) return;
      lastDiag = code;
      log('searchFilters ' + code);
    }
    function style(el, values) {
      for (var key in values) if (Object.prototype.hasOwnProperty.call(values, key))
        el.style[key] = values[key];
    }
    function visible(el) {
      if (!el.getClientRects || !el.getClientRects().length) return false;
      var st = window.getComputedStyle && window.getComputedStyle(el);
      if (st && (st.visibility === 'hidden' || st.display === 'none' ||
          Number(st.opacity) === 0)) return false;
      for (var p = el; p && p !== document.body; p = p.parentElement)
        if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
      return true;
    }
    // Эффективная видимость с учётом предков: клавиатура гаснет прозрачностью
    // у дальнего контейнера, поэтому идём до корня документа, а не на 7 уровней.
    function effVis(el) {
      var o = 1, p = el, i = 0;
      visZeroAt = -1;
      for (; p && p !== document.documentElement && i < 80; i++) {
        var st = window.getComputedStyle && window.getComputedStyle(p);
        if (st) {
          if (st.display === 'none' || st.visibility === 'hidden' ||
              st.visibility === 'collapse') { visZeroAt = i; return 0; }
          var a = parseFloat(st.opacity);
          if (!isNaN(a) && a < 1) {
            o *= a;
            if (o <= 0.04) { visZeroAt = i; return 0; }
          }
        }
        p = p.parentElement;
      }
      return o;
    }
    // Доля площади элемента, не срезанная предками с overflow != visible.
    // Клавиатура «уезжает» именно так: контейнер схлопывает высоту с обрезкой.
    function clipRatio(el) {
      var r0 = el.getBoundingClientRect();
      var area0 = r0.width * r0.height;
      if (!area0) return 0;
      var t = r0.top, b = r0.bottom, l = r0.left, r = r0.right;
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        var st = window.getComputedStyle && window.getComputedStyle(p);
        if (!st) continue;
        var ox = st.overflowX || st.overflow, oy = st.overflowY || st.overflow;
        if ((!ox || ox === 'visible') && (!oy || oy === 'visible')) continue;
        var pr = p.getBoundingClientRect();
        t = Math.max(t, pr.top); b = Math.min(b, pr.bottom);
        l = Math.max(l, pr.left); r = Math.min(r, pr.right);
      }
      if (b <= t || r <= l) return 0;
      return ((b - t) * (r - l)) / area0;
    }
    // Клавиша действительно отрисована сверху: в скрытом состоянии клавиатура
    // остаётся непрозрачной в DOM, но лежит ЗА страницей поиска.
    function keyPainted(key, kr) {
      var hit = null;
      try {
        hit = document.elementFromPoint(Math.round(kr.left + kr.width * .5),
          Math.round(kr.top + kr.height * .5));
      } catch (e) { return true; }
      if (!hit) return false;
      if (hit === key || key.contains(hit)) return true;
      var wrap = key.parentElement;
      return !!(wrap && wrap.contains(hit));
    }
    // Клавиатура реально на экране: размеры, координаты, прозрачность, обрезка,
    // и клавиша должна быть верхним элементом в своей точке.
    function keyboardVisible(key, kr, vw, vh) {
      if (!key || !kr) return false;
      if (!(kr.width > 0 && kr.height > 0)) return false;
      if (!(kr.bottom > 4 && kr.top < vh - 4 && kr.right > 4 && kr.left < vw - 4)) return false;
      if (key.checkVisibility) {
        try {
          if (!key.checkVisibility({ opacityProperty: true, visibilityProperty: true,
              contentVisibilityAuto: true })) return false;
        } catch (e) { }
      }
      if (effVis(key) <= 0.04) return false;
      if (clipRatio(key) <= 0.45) return false;
      return keyPainted(key, kr);
    }
    // Диагностика клавиатуры: почему считаем её видимой или скрытой.
    var probeAt = 0, lastProbe = '', visZeroAt = -1;
    function kbProbe(key, kr) {
      if (Date.now() - probeAt < 700) return;
      probeAt = Date.now();
      var hit = null;
      try {
        hit = document.elementFromPoint(Math.round(kr.left + kr.width * .5),
          Math.round(kr.top + kr.height * .5));
      } catch (e) { }
      var v = effVis(key);
      var line = 'kbprobe r=' + Math.round(kr.top) + ',' + Math.round(kr.left) + ',' +
        Math.round(kr.width) + 'x' + Math.round(kr.height) +
        ' vis=' + v.toFixed(2) + ' zz=' + visZeroAt +
        ' clip=' + clipRatio(key).toFixed(2) +
        ' hit=' + (hit ? String(hit.tagName || '').toLowerCase() : 'none') +
        ' inKey=' + (hit && (hit === key || key.contains(hit)) ? 1 : 0) +
        ' rows=' + document.querySelectorAll('yt-focus-container').length;
      if (hit && !(hit === key || key.contains(hit))) {
        var hr = hit.getBoundingClientRect();
        line += ' hcls=' + String(hit.className || hit.getAttribute('data-vot-search-filters') ||
          '').slice(0, 40) + '@' + Math.round(hr.top) + ',' + Math.round(hr.height);
      }
      if (line === lastProbe) return;
      lastProbe = line;
      log(line);
    }
    // Правый край клавиатуры, включая «&123»: панель встаёт только правее.
    function keyboardRight() {
      var keys = document.querySelectorAll('yt-keyboard-key'), max = 0;
      for (var i = 0; i < keys.length; i++) {
        if (!visible(keys[i])) continue;
        var r = keys[i].getBoundingClientRect();
        if (r.right > max) max = r.right;
      }
      return Math.round(max);
    }
    // Текст запроса нужен только чтобы понять, есть ли что искать; не логируем.
    function queryText() {
      var inputs = document.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        var v = inputs[i].value;
        if (typeof v === 'string' && v.length) return v;
      }
      return '';
    }
    function selected(gi) {
      if (gi < 0 || gi >= GROUPS.length) return 0;
      var n = Number(uiPref(GROUPS[gi].key, 0)), max = GROUPS[gi].items.length - 1;
      return n >= 0 && n <= max && Math.floor(n) === n ? n : 0;
    }
    function page() {
      var el = document.createElement('div');
      style(el, { position: 'absolute', left: '0', top: '0', width: '100%',
        height: '100%', boxSizing: 'border-box', padding: '12px',
        background: '#212121',
        transition: 'transform .2s cubic-bezier(.2,0,0,1), opacity .2s ease' });
      return el;
    }
    function makeRow(text) {
      var row = document.createElement('button');
      row.type = 'button';
      row.tabIndex = -1;
      style(row, { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '0 22px', margin: '0 0 6px 0', boxSizing: 'border-box',
        border: '0', borderRadius: '12px', outline: 'none', textAlign: 'left',
        fontFamily: 'inherit', fontWeight: '500', fontSize: '24px', cursor: 'pointer',
        background: '#272727', color: '#f1f1f1' });
      var label = document.createElement('span');
      label.textContent = text;
      style(label, { overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' });
      var tail = document.createElement('span');
      style(tail, { marginLeft: '18px', fontWeight: '400', fontSize: '20px',
        color: '#aaa', whiteSpace: 'nowrap' });
      row.appendChild(label);
      row.appendChild(tail);
      row.votLabel = label;
      row.votTail = tail;
      return row;
    }
    function paint() {
      var act = document.activeElement;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i], on = row === act;
        row.style.background = on ? '#f1f1f1' : '#272727';
        row.style.color = on ? '#0f0f0f' : '#f1f1f1';
        row.style.boxShadow = on ? '0 0 0 3px #fff' : 'none';
        if (row.votTail) {
          row.votTail.style.color = on ? '#0f0f0f' : '#aaa';
          if (i < GROUPS.length)
            row.votTail.textContent = GROUPS[i].items[selected(i)];
        }
      }
      for (var j = 0; j < items.length; j++) {
        var it = items[j], on2 = it === act;
        it.style.background = on2 ? '#f1f1f1' : '#272727';
        it.style.color = on2 ? '#0f0f0f' : '#f1f1f1';
        it.style.boxShadow = on2 ? '0 0 0 3px #fff' : 'none';
        if (it.votTail) {
          it.votTail.textContent = j === selected(openGroup) ? '✓' : '';
          it.votTail.style.color = on2 ? '#0f0f0f' : '#3ea6ff';
        }
      }
    }
    function head(text) {
      var el = document.createElement('div');
      el.textContent = text;
      style(el, { height: '42px', lineHeight: '40px', fontSize: '22px',
        fontWeight: '600', color: '#aaa', paddingLeft: '8px', marginBottom: '4px',
        boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden' });
      return el;
    }
    function buildRoot() {
      pageRoot.textContent = '';
      rows = [];
      pageRoot.appendChild(head('Фильтры'));
      for (var i = 0; i < GROUPS.length; i++) {
        var row = makeRow(GROUPS[i].title);
        row.setAttribute('data-vot-filter', GROUPS[i].key);
        row.addEventListener('focus', paint);
        row.addEventListener('blur', paint);
        row.addEventListener('click', (function (n) {
          return function () { openSub(n); };
        })(i));
        pageRoot.appendChild(row);
        rows.push(row);
      }
      var reset = makeRow('Сброс');
      reset.setAttribute('data-vot-reset', '');
      reset.addEventListener('focus', paint);
      reset.addEventListener('blur', paint);
      reset.addEventListener('click', resetAll);
      pageRoot.appendChild(reset);
      rows.push(reset);
    }
    function buildSub(gi) {
      pageSub.textContent = '';
      items = [];
      pageSub.appendChild(head(GROUPS[gi].title));
      var list = GROUPS[gi].items;
      for (var i = 0; i < list.length; i++) {
        var row = makeRow(list[i]);
        row.setAttribute('data-vot-value', String(i));
        row.addEventListener('focus', paint);
        row.addEventListener('blur', paint);
        row.addEventListener('click', (function (n) {
          return function () { pick(n); };
        })(i));
        pageSub.appendChild(row);
        items.push(row);
      }
      applySizes();
      paint();
    }
    // Высота строк считается от фактической высоты панели (границы задания).
    function applySizes() {
      if (!panel) return;
      var h = parseInt(panel.style.height, 10) || 380;
      var gap = 8, avail = h - 24 - 46;
      var n = rows.length || 1;
      var rh = Math.floor((avail - gap * (n - 1)) / n);
      if (rh > 104) rh = 104;
      if (rh < 34) rh = 34;
      var font = Math.max(22, Math.min(42, Math.round(rh * .46)));
      for (var i = 0; i < rows.length; i++)
        style(rows[i], { height: rh + 'px', fontSize: font + 'px' });
      var n2 = items.length;
      var rh2 = n2 ? Math.floor((avail - gap * (n2 - 1)) / n2) : rh;
      if (rh2 > 104) rh2 = 104;
      if (rh2 < 34) rh2 = 34;
      var font2 = Math.max(22, Math.min(44, Math.round(rh2 * .46)));
      for (var j = 0; j < n2; j++)
        style(items[j], { height: rh2 + 'px', fontSize: font2 + 'px' });
    }
    function openSub(gi) {
      if (!panel || gi < 0 || gi >= GROUPS.length) return;
      openGroup = gi;
      buildSub(gi);
      pageSub.style.transform = 'translateX(100%)';
      pageSub.style.opacity = '0';
      pageRoot.style.transform = 'translateX(-30%)';
      pageRoot.style.opacity = '0';
      if (pageSub.offsetWidth >= 0) { /* принудительный reflow для анимации */ }
      pageSub.style.transform = 'none';
      pageSub.style.opacity = '1';
      var sel = selected(gi);
      if (items[sel]) items[sel].focus();
      paint();
      diag('sub');
    }
    function closeSub() {
      if (openGroup < 0) return;
      var gi = openGroup;
      openGroup = -1;
      pageRoot.style.transform = 'none';
      pageRoot.style.opacity = '1';
      pageSub.style.transform = 'translateX(100%)';
      pageSub.style.opacity = '0';
      if (rows[gi]) rows[gi].focus();
      paint();
      diag('root');
    }
    function pick(i) {
      if (openGroup < 0 || i < 0 || i >= GROUPS[openGroup].items.length) return;
      uiSet(GROUPS[openGroup].key, i);
      log('searchFilters pick group=' + openGroup + ' value=' + i);
      paint();
      rerun();
    }
    function resetAll() {
      for (var i = 0; i < GROUPS.length; i++) uiSet(GROUPS[i].key, 0);
      log('searchFilters reset');
      paint();
      rerun();
    }
    function fireKey(el, type, code, keyName) {
      var ev = null;
      var kn = keyName || 'Enter';
      try {
        ev = new KeyboardEvent(type, { key: kn, code: kn, keyCode: code,
          which: code, bubbles: true, cancelable: true });
      } catch (e) {
        try {
          ev = document.createEvent('KeyboardEvent');
          ev.initKeyboardEvent(type, true, true, window, kn, 0, '', false, '');
          try {
            Object.defineProperty(ev, 'keyCode', { get: function () { return code; } });
          } catch (e2) { }
        } catch (e3) { ev = null; }
      }
      if (!ev) return;
      try { el.dispatchEvent(ev); } catch (e4) { }
    }
    // Отметка фильтра сразу повторяет текущий поиск (если запрос уже набран).
    function rerun() {
      if (!queryText()) { log('searchFilters refresh=noquery'); return; }
      if (Date.now() - rerunAt < 800) return;
      rerunAt = Date.now();
      var key = searchKey && document.body.contains(searchKey) ? searchKey : null;
      log('searchFilters refresh=go key=' + (key ? 1 : 0));
      if (!key) return;
      // Enter должен уйти штатному обработчику клавиши поиска.
      try { key.focus(); } catch (e) { }
      fireKey(key, 'keydown', 13);
      setTimeout(function () { fireKey(key, 'keyup', 13); }, 40);
    }
    function backToSearch() {
      closeSub();
      clearRing();
      // Left из окна возвращает фокус туда, откуда в него вошли (⌫, &123, 🌐,
      // «ПОИСК»), иначе — на клавишу «ПОИСК».
      var back = enterFrom && document.body.contains(enterFrom) ? enterFrom : searchKey;
      if (!back || !document.body.contains(back)) back = document.querySelector('input');
      if (back && back.focus) back.focus();
      paint();
      diag('blur to=' + tagOf(back));
    }
    // Анимацию скрытия окна берём у самой клавиатуры: длительность и кривую
    // читаем из computed style `ytlr-search-keyboard`, а не задаём константой.
    var kbAnim = '';
    function kbTransition(box) {
      if (!box) return '';
      var st = window.getComputedStyle && window.getComputedStyle(box);
      if (!st) return '';
      var dur = st.transitionDuration || '';
      var tf = st.transitionTimingFunction || '';
      if (!dur || dur === '0s' || dur === '0') dur = '0.3s';
      if (!tf || tf === 'ease') tf = 'cubic-bezier(0.26, 0.86, 0.44, 0.985)';
      return 'opacity ' + dur + ' ' + tf;
    }
    // Длительность этого перехода в миллисекундах — чтобы снять окно ровно
    // тогда, когда клавиатура закончила гаснуть.
    function kbAnimMs() {
      var m = /opacity\s+([\d.]+)(m?s)/.exec(kbAnim || '');
      if (!m) return 300;
      var v = parseFloat(m[1]);
      return m[2] === 's' ? Math.round(v * 1000) : Math.round(v);
    }
    // Прозрачность контейнера клавиатуры напрямую: клавиатура гаснет и
    // появляется именно ею, поэтому одного getComputedStyle за кадр хватает.
    function kbOpNow(box) {
      if (!box) return -1;
      var st = window.getComputedStyle && window.getComputedStyle(box);
      if (!st) return -1;
      var a = parseFloat(st.opacity);
      return isNaN(a) ? 1 : a;
    }
    // Сторож клавиатуры, один дешёвый замер за кадр. Гасим окно в том же кадре,
    // когда клавиатура начала гаснуть, и монтируем, как только она начала
    // проявляться, — окно и клавиатура анимируются синхронно.
    function fastWatch() {
      requestAnimationFrame(fastWatch);
      if (!ancBox || !document.body.contains(ancBox)) { kbOpPrev = 1; return; }
      var op = kbOpNow(ancBox);
      if (op < 0) return;
      if (op >= 0.98 || op <= 0.02) kbLeaving = false;
      else if (kbOpPrev >= 0.98) {
        kbLeaving = true;
        if (panel) { hide(); diag('sync drop'); }
      }
      if (!panel && !kbLeaving && op > 0.02 && kbOpPrev <= 0.02) scan();
      kbOpPrev = op;
    }
    function mount() {
      if (panel) return;
      try {
        panel = document.createElement('div');
        panel.setAttribute('data-vot-search-filters', '');
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', 'Фильтры поиска');
        style(panel, { position: 'fixed', zIndex: '2147483000',
          boxSizing: 'border-box', overflow: 'hidden', borderRadius: '16px',
          background: '#212121', boxShadow: '0 8px 28px rgba(0,0,0,.55)',
          fontFamily: 'Roboto, Arial, sans-serif', color: '#f1f1f1',
          opacity: '0',
          transition: kbAnim || 'opacity 0.3s cubic-bezier(0.26, 0.86, 0.44, 0.985)' });
        pageRoot = page();
        pageSub = page();
        pageSub.style.transform = 'translateX(100%)';
        pageSub.style.opacity = '0';
        panel.appendChild(pageRoot);
        panel.appendChild(pageSub);
        document.body.appendChild(panel);
        buildRoot();
        applySizes();
        paint();
        // Кадр с opacity 0 обязан быть посчитан, иначе перехода не будет; но
        // ждать таймер незачем — фиксируем значение чтением layout и сразу
        // включаем opacity, чтобы окно проявлялось вместе с клавиатурой.
        panel.getBoundingClientRect();
        panel.style.opacity = '1';
      } catch (e) {
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        panel = null; rows = []; items = [];
        diag('mount-fail');
      }
    }
    // Клавиатура лежит ниже выдачи: карточки наезжают на неё, когда уходишь
    // вниз. Ставим окно в тот же слой — сразу за клавиатурой, — чтобы карточки
    // наезжали и на окно, а не под ним. Если слой клавиатуры искажает позицию
    // (transform предка) или окно в нём перекрыто, возвращаемся в body.
    var layerBad = false, layerDone = false;
    function placeByKeyboard(kbEl, left, top, width) {
      if (!panel || layerBad || !kbEl) return;
      var host = kbEl.parentNode;
      if (!host || host === document.body) { layerBad = true; return; }
      if (layerDone) {
        if (panel.parentNode !== host) {
          try { host.insertBefore(panel, kbEl.nextSibling); } catch (e) { layerBad = true; }
        }
        return;
      }
      layerDone = true;
      var bad = false;
      if (panel.parentNode !== host) {
        try { host.insertBefore(panel, kbEl.nextSibling); } catch (e2) { bad = true; }
      }
      var r = bad ? null : panel.getBoundingClientRect();
      if (!r || Math.abs(r.left - left) > 2 || Math.abs(r.top - top) > 2) bad = true;
      if (!bad) {
        var hit = null;
        try { hit = document.elementFromPoint(Math.round(left + width / 2), Math.round(top + 20)); } catch (e3) { }
        if (!hit || !(hit === panel || panel.contains(hit))) bad = true;
      }
      if (bad) {
        layerBad = true;
        try { document.body.appendChild(panel); } catch (e4) { }
      }
      log('searchFilters layer=' + (bad ? 'body' : 'kb'));
    }
    // Плашку «Перевод: ожидание видео…» на экране поиска не показываем.
    function hideStatus() {
      var el = document.getElementById('vot-status');
      if (!el) return;
      el.style.setProperty('display', 'none', 'important');
      statusHidden = true;
    }
    function showStatus() {
      if (!statusHidden) return;
      statusHidden = false;
      var el = document.getElementById('vot-status');
      if (el) el.style.removeProperty('display');
    }
    function hide(silent) {
      if (!silent) diag('hidden');
      showStatus();
      clearRing();
      if (!panel) return;
      var p = panel;
      panel = null; rows = []; items = []; pageRoot = null; pageSub = null;
      openGroup = -1; searchKey = null; lastLayout = '';
      p.style.opacity = '0';
      clearTimeout(hideTimer);
      // Снимаем окно ровно тогда, когда клавиатура закончила гаснуть.
      hideTimer = setTimeout(function () {
        if (p.parentNode) p.parentNode.removeChild(p);
      }, kbAnimMs() + 20);
    }
    function fromSearch(active) {
      if (!active) return false;
      if (searchKey && (active === searchKey || searchKey.contains(active))) return true;
      var tag = String(active.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      try {
        if (active.closest && active.closest('ytlr-search-box, [role="combobox"]')) return true;
      } catch (e) { }
      return false;
    }
    // Поле ввода запроса: пилюля с фоном вокруг скрытого input или текста.
    function bgAlpha(el) {
      var st = window.getComputedStyle && window.getComputedStyle(el);
      if (!st) return 0;
      var m = /rgba?\(([^)]+)\)/.exec(st.backgroundColor || '');
      if (!m) return 0;
      var parts = m[1].split(',');
      return parts.length > 3 ? parseFloat(parts[3]) : 1;
    }
    function hasBg(el) {
      var st = window.getComputedStyle && window.getComputedStyle(el);
      if (!st) return false;
      var bi = st.backgroundImage;
      if (bi && bi !== 'none') return true;
      return bgAlpha(el) >= 0.25;
    }
    function pillBox(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        var r = p.getBoundingClientRect();
        if (r.height < 40 || r.height > 140) continue;
        if (r.width < 400) continue;
        if (r.top < 0 || r.bottom > window.innerHeight * .5) continue;
        if (!hasBg(p)) continue;
        return r;
      }
      return null;
    }
    // Поле ввода запроса: пилюля вокруг скрытого input или текста запроса.
    // Основной путь — точка в левой части пилюли (поле всегда в этом месте).
    function searchPillRect() {
      var w = window.innerWidth, h = window.innerHeight;
      var el = null;
      try {
        el = document.elementFromPoint(Math.round(w * .156), Math.round(h * .091));
      } catch (e) { }
      if (el && (panel ? !panel.contains(el) : true)) {
        for (var p = el; p && p !== document.body; p = p.parentElement) {
          var r = p.getBoundingClientRect();
          if (r.height < 40 || r.height > 140) continue;
          if (r.width < 400) continue;
          if (r.top < 0 || r.bottom > h * .5) continue;
          return r;
        }
      }
      var best = null, bestTop = 1e9;
      var ins = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      for (var i = 0; i < ins.length; i++) {
        var r0 = ins[i].getBoundingClientRect();
        if (r0.top < bestTop) { bestTop = r0.top; best = ins[i]; }
      }
      var box = best ? pillBox(best) : null;
      if (box) return box;
      var q = queryText();
      if (!q) return null;
      var list = document.querySelectorAll('div, span, yt-formatted-string');
      var leaf = null;
      bestTop = 1e9;
      for (var j = 0; j < list.length; j++) {
        var n = list[j];
        if (n.children.length) continue;
        if ((n.textContent || '').trim() !== q) continue;
        if (!visible(n)) continue;
        var r2 = n.getBoundingClientRect();
        if (!r2.width || !r2.height) continue;
        if (r2.top < bestTop) { bestTop = r2.top; leaf = n; }
      }
      return leaf ? pillBox(leaf) : null;
    }
    // Диагностика: цепочка предков input/textarea, если пилюлю найти не удалось.
    function chainLog() {
      var ins = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      var out = '';
      for (var i = 0; i < ins.length && i < 3; i++) {
        var p = ins[i];
        for (var d = 0; d < 3 && p && p !== document.body; d++) {
          var r = p.getBoundingClientRect();
          out += (d ? '>' : '') + String(p.tagName || '').toLowerCase() +
            '(' + Math.round(r.top) + ',' + Math.round(r.height) + ')';
          p = p.parentElement;
        }
        out += ' ';
      }
      log('searchFilters chain=' + (out || 'x'));
    }
    // Диагностика состояния: какие страницы в корне поиска и видны ли они.
    var skelDone = {};
    function skeleton(tag) {
      var root = document.querySelector('ytlr-classic-search-page') || document.body;
      var out = '', kids = root.children;
      for (var i = 0; i < kids.length && i < 6; i++) {
        var k = kids[i];
        var r = k.getBoundingClientRect();
        out += String(k.tagName || '').toLowerCase() + '[' + Math.round(r.top) + ',' +
          Math.round(r.height) + ',' + effVis(k).toFixed(2) + '] ';
      }
      log('skel ' + tag + ' ' + (out || 'x'));
    }
    // Клавиатуру определяем по её родному контейнеру ytlr-search-keyboard:
    // нативно она скрывается ровно его прозрачностью (opacity .3s), поэтому
    // прозрачность контейнера — единственный достоверный признак «клавиатура на
    // экране». Копий в DOM может быть несколько, берём непрозрачную на экране.
    function keyboardAnchor(vw, vh) {
      var boxes = null;
      try { boxes = document.querySelectorAll('ytlr-search-keyboard'); } catch (e) { }
      var res = { key: null, kr: null, sample: null, box: null, n: boxes ? boxes.length : 0 };
      if (!boxes) return res;
      for (var b = 0; b < boxes.length; b++) {
        var box = boxes[b];
        // Порог 0.02: как только клавиатура начала проявляться, окно должно
        // стартовать вместе с ней, а не после её полного появления.
        if (effVis(box) <= 0.02) continue;
        var br = box.getBoundingClientRect();
        if (!br.width || !br.height) continue;
        if (br.bottom <= 4 || br.top >= vh - 4) continue;
        var rowsAll = box.querySelectorAll('yt-focus-container');
        var bestTop = -1, bestRow = null;
        for (var i = 0; i < rowsAll.length; i++) {
          var row = rowsAll[i], ch = row.children;
          if (ch.length !== 3) continue;
          var ok = true, top = 0, prev = null;
          for (var j = 0; j < 3; j++) {
            if (!ch[j].querySelector('yt-keyboard-key[role="button"]')) { ok = false; break; }
            var r = ch[j].getBoundingClientRect();
            if (!r.width || !r.height || prev && (r.left < prev.left ||
                Math.abs(r.top - prev.top) > 24)) { ok = false; break; }
            prev = r; top = r.top;
          }
          if (ok && top > bestTop) { bestTop = top; bestRow = row; }
        }
        if (!bestRow) continue;
        var k = bestRow.children[2].querySelector('yt-keyboard-key[role="button"]');
        var kr = k ? k.getBoundingClientRect() : null;
        if (!kr) continue;
        if (!res.sample) res.sample = { key: k, kr: kr, box: box };
        if (!res.key) { res.key = k; res.kr = kr; res.box = box; }
      }
      return res;
    }
    // Как нативно скрывается клавиатура: чем анимируются клавиша, ряд и контейнеры.
    function kbHideTrace(sample) {
      if (!sample || !sample.key) return;
      var key = sample.key;
      var dump = function (tag) {
        var row = null;
        try { row = key.closest ? key.closest('yt-focus-container') : null; } catch (e) { }
        log('kbhide ' + tag + ' key: ' + animOf(key) +
          ' row: ' + (row ? animChain(row, 3) : 'x'));
      };
      dump('t0');
      setTimeout(function () { dump('t250'); }, 250);
    }
    function scan() {
      if (panel && !document.body.contains(panel)) {
        panel = null; rows = []; items = []; pageRoot = null; pageSub = null;
        openGroup = -1; searchKey = null; lastLayout = '';
      }
      // Окно фильтров видно только вместе с клавиатурой поиска. Клавиатура
      // остаётся в DOM, поэтому смотрим координаты, прозрачность, обрезку и то,
      // что клавиша реально верхняя в своей точке.
      var vw = window.innerWidth, vh = window.innerHeight;
      var anc = keyboardAnchor(vw, vh);
      // Сторож работает по этому контейнеру; при смене копии клавиатуры
      // сбрасываем прежнее значение прозрачности.
      if (anc.box !== ancBox) {
        ancBox = anc.box;
        kbOpPrev = anc.box ? kbOpNow(anc.box) : 1;
      }
      var key = anc.key, kr = anc.kr, kb = !!(key && kr);
      if (panel && anc.sample) kbProbe(anc.sample.key, anc.sample.kr);
      if (kb !== lastKb) {
        lastKb = kb;
        if (!skelDone[kb ? 1 : 0]) { skelDone[kb ? 1 : 0] = true; skeleton(kb ? 'kb1' : 'kb0'); }
        if (!kb) kbHideTrace(anc.sample);
      }
      if (!kb) {
        // Гасим, как только клавиатура пропала: пока окно на экране, ждём
        // считанные кадры, без окна — не суетимся.
        if (kbGoneSince === 0) kbGoneSince = Date.now();
        if (Date.now() - kbGoneSince >= (panel ? 32 : 120)) { kbSeen = false; hide(); return; }
        return;
      }
      kbGoneSince = 0;
      // Клавиатура уже начала гаснуть — окно гасим тем же тактом и тем же
      // переходом. Направление берём у сторожа: пока клавиатура проявляется,
      // окно должно проявляться вместе с ней, а не гаснуть.
      var kbOp = anc.box ? effVis(anc.box) : 1;
      if (kbLeaving) { if (panel) hide(); return; }
      kbSeen = true;
      // Длительность и кривая гашения окна — ровно как у клавиатуры.
      var tr = kbTransition(anc.box);
      if (tr && tr !== kbAnim) {
        kbAnim = tr;
        if (panel) panel.style.transition = tr;
        log('searchFilters anim=' + tr + ' ms=' + kbAnimMs());
      }
      // Ушли из панели на выдачу — окно держим скрытым, пока фокус не вернётся
      // в клавиатуру или в поле поиска.
      if (awayToResults) {
        var act = document.activeElement;
        var backIn = act && (isKeyboardEl(act) || fromSearch(act) ||
          (panel && panel.contains(act)));
        if (!backIn) { hide(true); return; }
        awayToResults = false;
      }
      // Пока идёт переход «Сброс» → первая карточка, панель не монтируем снова.
      if (Date.now() < suppressUntil) { hide(true); return; }
      hideStatus();
      var w = window.innerWidth, h = window.innerHeight;
      // Верх = верхняя граница поля ввода, низ = низ ряда клавиш «Поиск» и т.д.
      var pill = searchPillRect();
      var top = pill ? Math.round(pill.top) : Math.round(h * .143);
      var bottom = Math.round(kr.bottom);
      var left = Math.max(Math.round(w * .6875), Math.ceil(keyboardRight() + 24));
      var width = Math.round(w - left - 12);
      var height = bottom - top;
      if (width < 300) { hide(true); diag('narrow'); return; }
      if (height < 220) { hide(true); diag('low'); return; }
      if (!panel) mount();
      if (!panel) return;
      searchKey = key;
      var layout = left + ',' + top + ',' + width + ',' + height;
      if (layout !== lastLayout) {
        style(panel, { left: left + 'px', top: top + 'px',
          width: width + 'px', height: height + 'px' });
        lastLayout = layout;
        applySizes();
        paint();
        log('searchFilters geo top=' + top + ' bot=' + bottom + ' left=' + left +
          ' w=' + width + ' h=' + height + ' pill=' +
          (pill ? Math.round(pill.top) + '-' + Math.round(pill.bottom) : 'x'));
        if (!pill && !chainDone) { chainDone = true; chainLog(); }
      }
      placeByKeyboard(anc.box, left, top, width);
      diag(openGroup >= 0 ? 'shown-sub' : 'shown');
    }
    // ---- переход из панели в выдачу -----------------------------------------
    function isKeyboardEl(el) {
      try {
        if (el.closest && el.closest('yt-keyboard-key, yt-keyboard')) return true;
      } catch (e) { }
      return String(el.tagName || '').toUpperCase().indexOf('YT-KEYBOARD') === 0;
    }
    // Первая карточка выдачи (страховка, если фокус не удалось запомнить).
    // Ищем именно карточку: контейнер виртуального списка тоже подходит под
    // общие роли и перекрывает её по геометрии, поэтому набор сужен.
    // Карточку ищем по геометрии и прозрачности, без visible(): выдача может
    // лежать под aria-hidden слоем, пока открыта клавиатура.
    function cardVis(el) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
      if (r.width < 80 || r.height < 60) return false;
      var st = window.getComputedStyle && window.getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      return effVis(el) > 0.04;
    }
    function tagOf(el) {
      if (!el) return 'none';
      var s = String(el.tagName || '').toLowerCase();
      try {
        var ti = el.getAttribute && el.getAttribute('tabindex');
        if (ti != null) s += '#' + ti;
        var ro = el.getAttribute && el.getAttribute('role');
        if (ro) s += '.' + ro;
      } catch (e) { }
      return s;
    }
    // Первая карточка выдачи по геометрии (левая верхняя на экране).
    function pickCard(sel) {
      var list = null;
      try { list = document.querySelectorAll(sel); } catch (e) { return null; }
      var best = null, bestTop = 1e9, bestLeft = 1e9;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (panel && panel.contains(el)) continue;
        if (isKeyboardEl(el) || fromSearch(el)) continue;
        if (!cardVis(el)) continue;
        var r2 = el.getBoundingClientRect();
        if (r2.top < bestTop - 1 || Math.abs(r2.top - bestTop) <= 1 && r2.left < bestLeft) {
          best = el; bestTop = r2.top; bestLeft = r2.left;
        }
      }
      return best;
    }
    // Нативно Down с клавиатуры уходит на ytlr-playback-preview[role=gridcell] —
    // именно этот элемент приложение само ставит в фокус в выдаче.
    function firstResultEl() {
      return pickCard('ytlr-playback-preview') ||
        pickCard('yt-lockup-view-model, ytlr-video-renderer, ytlr-grid-video-renderer, ' +
          'ytlr-playlist-renderer, ytlr-channel-renderer');
    }
    // Фокус ставим напрямую на элемент карточки — так же, как делает приложение.
    function focusCard(el) {
      if (!el || !el.focus) return false;
      try { el.focus(); } catch (e) { return false; }
      return document.activeElement === el || (el.contains && el.contains(document.activeElement));
    }
    function firstCard() {
      var t = firstResultEl();
      if (!t && resultEl && document.body.contains(resultEl)) t = resultEl;
      return t || null;
    }
    // Переход «Сброс» → выдача делаем нативно: возвращаем фокус клавише нижнего
    // ряда («ПОИСК») и отдаём ей Down — дальше плеер сам ставит фокус на первую
    // карточку, ровно как при обычном Down с клавиатуры. Окно при этом гаснет.
    function leaveToResults() {
      var anc = keyboardAnchor(window.innerWidth, window.innerHeight);
      var key = anc && anc.key;
      suppressUntil = Date.now() + 700;
      awayToResults = true;
      hide();
      if (!key) { diag('to-results key=0'); return; }
      try { key.focus(); } catch (e) { }
      fireKey(key, 'keydown', 40, 'ArrowDown');
      setTimeout(function () { fireKey(key, 'keyup', 40, 'ArrowDown'); }, 40);
      setTimeout(function () {
        var a = document.activeElement;
        diag('to-results act=' + tagOf(a) + ' inKb=' + (isKeyboardEl(a) ? 1 : 0));
      }, 320);
    }
    // Нижний ряд клавиатуры: «Пробел», «Очистить», «Поиск».
    function inBottomRow(el) {
      if (!el || !isKeyboardEl(el)) return false;
      var row = null;
      try { row = el.closest ? el.closest('yt-focus-container') : null; } catch (e) { }
      if (!row || row.children.length !== 3) return false;
      for (var i = 0; i < 3; i++)
        if (!row.children[i].querySelector('yt-keyboard-key[role="button"]')) return false;
      return true;
    }
    // Текущий элемент вверх по дереву: тег, tabindex, роль, координаты.
    function chainOf(el) {
      var s = '', p = el;
      for (var d = 0; d < 5 && p && p !== document.body; d++, p = p.parentElement) {
        var r = p.getBoundingClientRect();
        s += (d ? '>' : '') + tagOf(p) + '@' + Math.round(r.top) + ',' +
          Math.round(r.left) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
      }
      return s || 'x';
    }
    // Стили перехода элемента: чем именно анимируется нативный переход.
    function animOf(el) {
      var st = window.getComputedStyle && window.getComputedStyle(el);
      if (!st) return 'x';
      return 'tr=' + (st.transitionProperty || '-') + '/' + (st.transitionDuration || '-') +
        '/' + (st.transitionTimingFunction || '-') +
        ' tf=' + String(st.transform || '-').slice(0, 32) + ' op=' + st.opacity;
    }
    function animChain(el, depth) {
      var s = '', p = el;
      for (var d = 0; d < depth && p && p !== document.body; d++, p = p.parentElement)
        s += (d ? ' | ' : '') + String(p.tagName || '').toLowerCase() + ': ' + animOf(p);
      return s || 'x';
    }
    // Запоминаем карточку выдачи, чтобы вернуться к ней с «Сброса».
    // Заодно логируем нативный переход: что получает фокус и как оно анимируется.
    document.addEventListener('focusin', function (e) {
      var a = e.target;
      if (!a || a === document.body) return;
      if (panel && panel.contains(a)) return;
      if (fromSearch(a) || isKeyboardEl(a)) return;
      // Фокус ушёл в выдачу — окно начинает гаснуть в том же кадре, что и
      // клавиатура (её гасит само приложение), не дожидаясь такта скана.
      if (panel) { awayToResults = true; hide(); }
      resultEl = a;
      var now = Date.now();
      if (now - lastNavLog > 400) {
        lastNavLog = now;
        log('nav focusin ' + chainOf(a) + ' || ' + animOf(a));
      }
    }, true);
    // Правее последней клавиши ряда на экране только окно фильтров, поэтому
    // Right с «⌫», «&123», «🌐» и «ПОИСК» должно вести в него так же, как из
    // поля поиска.
    function isRowLastKey(el) {
      if (!el || !isKeyboardEl(el)) return false;
      var row = null;
      try { row = el.closest ? el.closest('yt-focus-container') : null; } catch (e) { }
      if (!row) return false;
      var kids = row.children, last = kids[kids.length - 1];
      if (!last) return false;
      if (last === el || last.contains(el)) return true;
      var r = el.getBoundingClientRect(), lr = last.getBoundingClientRect();
      return lr.width > 0 && r.right > lr.right - 6;
    }
    // После входа в окно на клавише остаётся белый маркер фокуса — смотрим,
    // чем он нарисован (класс/предок/контур), чтобы убрать его.
    function clsOf(el) {
      if (!el) return 'none';
      var s = '';
      try {
        s = String(el.getAttribute('class') || '-');
        var p = el.parentElement;
        if (p && p.getAttribute) s += ' / ' + String(p.getAttribute('class') || '-');
        var st = window.getComputedStyle && window.getComputedStyle(el);
        if (st) s += ' | out=' + st.outlineStyle + '/' + st.outlineWidth +
          ' bs=' + String(st.boxShadow || '-').slice(0, 20);
      } catch (e) { }
      return s.slice(0, 240);
    }
    // Белый маркер фокуса клавиши рисуется самим приложением по своему
    // состоянию навигации, поэтому после программной передачи фокуса в окно он
    // остаётся. Ищем, чем он нарисован: пустой элемент в размер клавиши с
    // рамкой/тенью/фоном — это и есть рамка фокуса.
    function boxSig(el) {
      var st = window.getComputedStyle && window.getComputedStyle(el);
      if (!st) return 'x';
      return 'b=' + st.borderTopWidth + '/' + st.borderTopColor +
        ' bg=' + st.backgroundColor + ' im=' + String(st.backgroundImage || 'none').slice(0, 14) +
        ' sh=' + String(st.boxShadow || 'none').slice(0, 14) + ' o=' + st.opacity;
    }
    function sameBox(a, b) {
      if (!a || !b) return false;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return Math.abs(ra.width - rb.width) <= 12 && Math.abs(ra.height - rb.height) <= 12 &&
        Math.abs(ra.top - rb.top) <= 12 && Math.abs(ra.left - rb.left) <= 12;
    }
    function ringCandidates(key) {
      var out = [];
      if (!key) return out;
      var box = null;
      try { box = key.closest ? key.closest('ytlr-search-keyboard') : null; } catch (e) { }
      if (!box) box = key.parentElement;
      if (!box) return out;
      var list = box.querySelectorAll('*');
      for (var i = 0; i < list.length && out.length < 4; i++) {
        var el = list[i];
        if (el === key) continue;
        // Текст и предков не трогаем: рамка — пустой слой, а не буква.
        if (String(el.textContent || '').trim()) continue;
        if (el.contains && el.contains(key)) continue;
        if (!sameBox(el, key)) continue;
        var st = window.getComputedStyle && window.getComputedStyle(el);
        if (!st) continue;
        var painted = parseFloat(st.borderTopWidth) > 0 ||
          String(st.boxShadow || 'none') !== 'none' ||
          String(st.backgroundImage || 'none') !== 'none' || bgAlpha(el) > 0.05;
        if (!painted) continue;
        out.push(el);
      }
      return out;
    }
    function ringProbe(key) {
      if (ringLogged || !key) return;
      ringLogged = true;
      var out = 'key{' + boxSig(key) + '}';
      var p = key.parentElement;
      for (var d = 0; d < 2 && p && p !== document.body; d++, p = p.parentElement)
        out += ' p' + d + '{' + boxSig(p) + '}';
      var c = ringCandidates(key);
      for (var i = 0; i < c.length; i++)
        out += ' c' + i + '.' + String(c[i].getAttribute('class') || '-').slice(0, 20) +
          '{' + boxSig(c[i]) + '}';
      log('ring n=' + c.length + ' ' + out.slice(0, 640));
    }
    // Пока фокус в окне, белый маркер с клавиши снимаем; на Left возвращаем.
    // Найденный слой запоминаем на самой клавише, чтобы не сканировать клавиатуру
    // на каждом входе.
    function markRing(key) {
      clearRing();
      var c = null;
      var cached = key ? key.__votRing : null;
      if (cached && document.body.contains(cached) && sameBox(cached, key)) c = [cached];
      else c = ringCandidates(key);
      if (c && c.length && c[0].nodeType === 1) {
        try { key.__votRing = c[0]; } catch (e) { }
      }
      for (var i = 0; i < (c ? c.length : 0); i++) {
        ringEls.push({ el: c[i], op: c[i].style.opacity });
        c[i].style.setProperty('opacity', '0', 'important');
      }
      log('ring hide n=' + (c ? c.length : 0));
    }
    function clearRing() {
      for (var i = 0; i < ringEls.length; i++) {
        var s = ringEls[i];
        try {
          if (s.op) s.el.style.opacity = s.op; else s.el.style.removeProperty('opacity');
        } catch (e) { }
      }
      ringEls = [];
    }
    function onKey(e) {
      var code = e.keyCode || e.which, active = document.activeElement;
      // Down с нижнего ряда клавиатуры не перехватываем: плеер сам уводит
      // фокус на первую карточку (ytlr-playback-preview) — проверено нативно.
      if (!panel || !document.body.contains(panel)) return;
      var rootIndex = rows.indexOf(active), subIndex = items.indexOf(active);
      if (rootIndex < 0 && subIndex < 0) {
        if (code !== 39) return;
        if (!fromSearch(active) && !isRowLastKey(active)) return;
        var start = 0;
        if (!rows.length) return;
        enterFrom = active;
        var keyCls = clsOf(active);
        ringProbe(active);
        rows[start].focus();
        if (document.activeElement !== rows[start]) return;
        markRing(active);
        diag('enter by=' + tagOf(active));
        log('marker before=' + keyCls + ' after=' + clsOf(active));
      } else if (subIndex >= 0) {
        if (code === 38) items[(subIndex + items.length - 1) % items.length].focus();
        else if (code === 40) items[(subIndex + 1) % items.length].focus();
        else if (code === 37) { closeSub(); }
        else if (code === 13 || code === 23) { pick(subIndex); }
        else return;
      } else {
        if (code === 38) rows[(rootIndex + rows.length - 1) % rows.length].focus();
        else if (code === 40) {
          if (rootIndex === rows.length - 1) leaveToResults();
          else rows[rootIndex + 1].focus();
        }
        else if (code === 37) { backToSearch(); }
        else if (code === 39 || code === 13 || code === 23) {
          if (rootIndex === rows.length - 1) resetAll();
          else openSub(rootIndex);
        } else return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
    document.addEventListener('keydown', onKey, true);
    // Диагностика нативных переходов: куда уходит фокус и как это анимируется.
    document.addEventListener('keydown', function (e) {
      var code = e.keyCode || e.which;
      if (code !== 37 && code !== 38 && code !== 39 && code !== 40 &&
          code !== 13 && code !== 23) return;
      var a = document.activeElement;
      if (!a || a === document.body) return;
      if (panel && panel.contains(a)) return;
      // ВРЕМЕННАЯ диагностика: почему Right в баре плеера уводит фокус из ряда.
      if (code === 39) {
        try {
          var bar = a.closest ? a.closest('ytlr-player-actions-container') : null;
          if (bar) {
            var nodes = bar.querySelectorAll('ytlr-button-renderer, ytlr-video-owner-renderer');
            var out = [];
            for (var q = 0; q < nodes.length && out.length < 24; q++) {
              var nd = nodes[q], r2 = nd.getBoundingClientRect();
              if (!r2.width && !r2.height) continue;
              var lb2 = '';
              try {
                lb2 = String(nd.getAttribute('aria-label') || nd.getAttribute('title') || '');
                if (!lb2) {
                  var in2 = nd.querySelector('[aria-label],[title]');
                  if (in2) lb2 = String(in2.getAttribute('aria-label') || in2.getAttribute('title') || '');
                }
              } catch (e6) { }
              out.push(String(nd.tagName || '?').toLowerCase().replace('ytlr-', '')
                + '[' + lb2.slice(0, 18) + ']' + Math.round(r2.left) + ',' + Math.round(r2.top)
                + ' ' + Math.round(r2.width) + 'x' + Math.round(r2.height)
                + ' ti=' + (nd.getAttribute ? nd.getAttribute('tabindex') : '-')
                + ' ah=' + (nd.getAttribute ? nd.getAttribute('aria-hidden') : '-')
                + ' dis=' + (nd.disabled ? 1 : 0));
            }
            log('bar dump n=' + out.length + ': ' + out.join(' | '));
          }
        } catch (e7) { }
      }
      var before = chainOf(a);
      setTimeout(function () {
        log('nav key=' + code + ' from=' + before + ' to=' +
          chainOf(document.activeElement) + ' | ' + animOf(document.activeElement));
      }, 240);
    }, true);
    window.addEventListener('vot-pref', function (e) {
      if (!e.detail) return;
      for (var i = 0; i < GROUPS.length; i++)
        if (e.detail.key === GROUPS[i].key) { paint(); return; }
    });
    // Пока панель на экране, клавиатуру опрашиваем чаще, чтобы окно уезжало
    // вместе с ней, а не через четверть секунды.
    function tick() {
      scan();
      // Синхронизацию анимации ведёт покадровый сторож, скану достаточно
      // раз в 100 мс: геометрия и монтаж окна.
      setTimeout(tick, panel || kbSeen ? 100 : 250);
    }
    try { requestAnimationFrame(fastWatch); } catch (e) { }
    tick();
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
    // Unknown→hold означает, что перевод НЕ запущен: первое нажатие 文A
    // должно принудительно включить его, а не выключить уже остановленный.
    if (state.langWaitForId === id && state.forceTranslate !== id) {
      state.paintOn = false;
      return false;
    }
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
    if (!cmd) return null; // без шаблона не вставляем пункт, открывающий DOM popup
    var lr = {
      title: { simpleText: 'Перевод Яндекс' },
      icon: { iconType: 'TRANSLATE' },
      // Стрелка — как у плашек, открывающих подменю («Скорость», «Пожалуйста»).
      secondaryIcon: { iconType: 'CHEVRON_RIGHT' }
    };
    lr.serviceEndpoint = { commandExecutorCommand: { commands: [cmd] } };
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
      var item = votPopupItem();
      if (!item) continue;
      arr.splice(Math.min(2, arr.length), 0, item);
      if (popupLog < 12) {
        popupLog++;
        var tt = [];
        for (var j = 0; j < arr.length && j < 14; j++) tt.push(linkTitle(arr[j]));
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
            log('popup inst=' + inst.__votId + ' kind=' +
              (uid === 'playback-settings' ? 'playback' : cmd.__votOwn ? 'own' : 'other')
              + ' own=' + (cmd.__votOwn ? 1 : 0));
          }
        }
      } catch (e9) { }
      try {
        if (handleAction(actionOf(cmd))) return true;
        // Вложенные команды исполняем только для «нажатия» пункта. Если команда
        // сама открывает попап (openPopupAction), это перерисовка панели: клиент
        // переиспользует вложенный список при каждом рендере, и наши VOT_SET
        // срабатывали сами по себе (проверено на ТВ: dub=dub/dub=yandex в цикле).
        var cc = (!cmd || !cmd.openPopupAction)
          ? (cmd && cmd.commandExecutorCommand && cmd.commandExecutorCommand.commands) : null;
        if (cc && cc.length) {
          for (var i = 0; i < cc.length; i++) {
            if (handleAction(actionOf(cc[i]))) return true;
          }
        }
      } catch (e) { }
      if (doPopup && cmd && cmd.openPopupAction) {
        try { sortProbePopup(cmd, name); } catch (probeErr) { }
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
      // Витрина статуса теперь одна (#vot-status); старое #vot-toast удалено.
      toast = stShown ? 1 : 0;
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
      // Витрина статуса прячется/показывается вместе с баром плеера.
      statusTick();
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
  // Даты в поиске — собственные кнопки справа от штатной клавиатуры.
  setupSearchSortProbe();
  setupSearchFilters();
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
  var LIMIT = 120;
  var sent = 0;
  var seen = {};

  function post(text) {
    // Поиск может случиться спустя часы после старта, когда общий бюджет
    // диагностических строк исчерпан; оставляем ему отдельные 12 строк.
    if (sent >= LIMIT && (sent >= LIMIT + 12 || String(text).indexOf('search ') !== 0)) return;
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
    var s = String(i || '');
    // Клиент этой сборки может ходить и в /youtubei/v1/player, и в старые
    // точки (/get_video_info, /youtubei/v1/player/ad_break, /watch). Диагностика
    // `net <method> <host/path>` покажет реальный адрес.
    return s.indexOf('/youtubei/v1/player') >= 0 || s.indexOf('/get_video_info') >= 0;
  }

  // Каталог запросов: хост+путь без query, чтобы увидеть, куда плеер реально
  // ходит за player-ответом (хук /youtubei/v1/player на этой сборке не срабатывает).
  function netKey(u) {
    var s = String(u || '').replace(/^https?:\/\//, '');
    var q = s.indexOf('?');
    if (q > 0) s = s.slice(0, q);
    return s.slice(0, 80) || '-';
  }

  function netLog(m, u) {
    try {
      var k = netKey(u);
      once('url|' + m + '|' + k, 'net ' + m + ' ' + k);
    } catch (e) { }
  }

  function hasN(u) {
    return /[?&]n=/.test(String(u || '')) ? 1 : 0;
  }

  // ---- последний аудио-URL, который запросил сам плеер ---------------------
  // InnerTube из Java на этом ТВ всё чаще отвечает LOGIN_REQUIRED («confirm
  // you're not a bot»), а страница тот же ролик спокойно играет. Поэтому URL
  // берём у плеера: он уже подписан и принят сетью. clen в нём есть параметром,
  // отдельно считать не нужно.
  var AUDIO_ITAGS = { 139: 1, 140: 1, 141: 1, 249: 1, 250: 1, 251: 1, 256: 1, 258: 1 };
  var AUD = null;

  // Текущий id ролика из адреса/ytcfg; используется и захватом, и поиском url.
  function curVid() {
    return (typeof capVideoId === 'function') ? capVideoId() : '';
  }

  function rememberAudio(u) {
    var s = String(u || '');
    if (s.indexOf('googlevideo.com') < 0) return;
    if (s.indexOf('videoplayback') < 0) return;
    var itag = parseInt((/[?&]itag=(\d+)/.exec(s) || [])[1] || '0', 10);
    if (!AUDIO_ITAGS[itag]) return;
    var clen = parseInt((/[?&]clen=(\d+)/.exec(s) || [])[1] || '0', 10);
    if (!(clen > 0)) return;
    // Плеер просит файл кусками и пишет окно в сам URL (`range`/`rn`). Для
    // целой дорожки окно надо убрать, иначе сервер отдаст только его.
    var clean = s.replace(/([?&])range=[^&]*/g, '$1').replace(/([?&])rn=[^&]*/g, '$1');
    AUD = { url: clean, itag: itag, clen: clen, ts: Date.now(), vid: curVid() };
  }

  // Наружу: vot.js спрашивает этот url, когда мост не смог добыть свой.
  window.__votAudioSrc = function () {
    if (!AUD) return null;
    // URL годится только для того ролика, на котором он пойман: у плеера он
    // переживает переход на следующее видео и отдаётся с age в минуты.
    var cur = curVid();
    if (AUD.vid && cur && AUD.vid !== cur) return null;
    return { url: AUD.url, itag: AUD.itag, clen: AUD.clen, age: Date.now() - AUD.ts, vid: AUD.vid };
  };

  // ---- снятый SABR-запрос самого плеера ------------------------------------
  // Мост получает serverAbrStreamingUrl, но его собственный POST отбивается
  // 403 (пустое тело) — значит режет либо подпись/`n` в URL, либо набор
  // заголовков. Снимаем запрос плеера целиком (url + headers + тело в base64)
  // и повторяем его байт в байт из Java: так видно, что именно не так.
  var SABR_MAX = 64 * 1024;
  var SABR = null;

  function isSabr(u) {
    var s = String(u || '');
    return s.indexOf('googlevideo.com') >= 0 && /[?&]sabr=/.test(s);
  }

  function strBytes(s) {
    try {
      if (window.TextEncoder) return new TextEncoder().encode(String(s));
    } catch (e) { }
    var out = [];
    s = String(s);
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
    return out;
  }

  function b64buf(buf) {
    try {
      var bytes = new Uint8Array(buf);
      if (!bytes.length || bytes.length > SABR_MAX) return '';
      var out = '';
      for (var i = 0; i < bytes.length; i += 4096) {
        out += String.fromCharCode.apply(null,
          bytes.subarray(i, Math.min(i + 4096, bytes.length)));
      }
      return btoa(out);
    } catch (e) { return ''; }
  }

  // Diagnostic only: decode field 1.69 from the actual page SABR POST, never
  // from our replay request or a free-text match elsewhere in the protobuf.
  var sabrDiagSeen = {};
  function sabrDiagParse(bytes) {
    var end = bytes.length, pos = 0, track = null, found = false;
    function number(limit) {
      var value = 0, scale = 1;
      for (var i = 0; i < 10; i++) {
        if (pos >= limit) throw 'truncated';
        var octet = bytes[pos++], part = octet & 127;
        if (part > Math.floor((9007199254740991 - value) / scale)) throw 'overflow';
        value += part * scale;
        if (!(octet & 128)) return value;
        scale *= 128;
      }
      throw 'varint';
    }
    function skipVarint(limit) {
      for (var i = 0; i < 10; i++) {
        if (pos >= limit) throw 'truncated';
        var octet = bytes[pos++];
        if (!(octet & 128)) {
          if (i === 9 && octet > 1) throw 'varint';
          return;
        }
      }
      throw 'varint';
    }
    function walk(limit, nested) {
      while (pos < limit) {
        var tag = number(limit), field = Math.floor(tag / 8), wire = tag % 8;
        if (!field || field > 536870911) throw 'tag';
        if (((!nested && field === 1) || (nested && field === 69)) && wire !== 2) throw 'wire';
        if (wire === 0) { skipVarint(limit); continue; }
        if (wire === 1 || wire === 5) {
          var size = wire === 1 ? 8 : 4;
          if (size > limit - pos) throw 'truncated';
          pos += size;
          continue;
        }
        if (wire !== 2) throw 'wire';
        var len = number(limit);
        if (len > limit - pos) throw 'truncated';
        var stop = pos + len;
        if (!nested && field === 1) {
          walk(stop, true);
        } else if (nested && field === 69) {
          found = true;
          if (len > 64) throw 'track-length';
          var id = '';
          for (; pos < stop; pos++) {
            if (bytes[pos] < 33 || bytes[pos] > 126) throw 'track-ascii';
            id += String.fromCharCode(bytes[pos]);
          }
          if (track !== null && track !== id) throw 'track-conflict';
          track = id;
        }
        pos = stop;
      }
      if (pos !== limit) throw 'truncated';
    }
    try {
      walk(end, false);
      return { status: found ? (track ? 'present' : 'empty') : 'absent', id: track || '' };
    } catch (e) { return { status: 'invalid', id: '' }; }
  }

  // ---- какие дорожки вообще есть у этого ролика ----------------------------
  // SABR-запрос плеера НЕ содержит xtags (проверено на ТВ: acontBody=0), зато
  // несёт audioTrackId (`en-US.4`) — это и есть звучащая дорожка. Роль/язык
  // берём из player-ответа, где у формата есть и id, и xtags. Так «что играет»
  // определяется по факту, а не по догадке из подсказок.
  var AUDMAP = {}, AUDMAP_VID = '', AUDMAP_AT = 0;
  // id ролика из последнего player-ответа: на ТВ `location.href` иногда ещё не
  // содержит watch-адрес (Cobalt грузит /tv и переходит роутером), а videoId в
  // ответе плеера есть всегда.
  var PLAYER_VID = '';
  // Что уже отправлено в мост: /track нужен один раз на (ролик, дорожку).
  var TRACK_SENT = {};

  function langBaseOf(v) {
    return String(v || '').toLowerCase().split('-')[0];
  }

  function parseXtags(raw) {
    var s = String(raw || '');
    if (!s) return null;
    function pick(t) {
      // Текст после декода protobuf — это пары «ключ, значение» БЕЗ '=': на месте
      // разделителя служебные байты длин (0x00..0x1f). Поэтому разделитель —
      // любой служебный байт, '=' (текстовая форма Java) или ':'.
      var A = /acont[=: \x00-\x1f]*([A-Za-z0-9_-]+)/.exec(t);
      var L = /(?:^|[^A-Za-z])lang[=: \x00-\x1f]*([A-Za-z]{2,10}(?:-[A-Za-z0-9]{2,8})?)/.exec(t);
      if (!A && !L) return null;
      var acont = A ? A[1].toLowerCase() : '';
      return { acont: acont, lang: L ? L[1].toLowerCase() : '',
               dubbed: /dubbed/i.test(t) || acont.indexOf('dub') >= 0 };
    }
    var r = pick(s);
    // Сначала текстовая форма (мост уже развернул protobuf в `k=v:k=v`), затем
    // исходный base64url из player-ответа: без второго шага карта дорожек
    // оставалась без ролей, и любой русский оригинал выглядел «неизвестным».
    if (r && r.acont && r.lang) return r;
    if (/^[A-Za-z0-9_\-+\/=]{16,}$/.test(s)) {
      try {
        var b = atobStr(s.replace(/-/g, '+').replace(/_/g, '/'));
        if (b) { var r2 = pick(b); if (r2) return r2; }
      } catch (e) { }
    }
    return r || null;
  }

  // Карта построена по ответу ТЕКУЩЕГО ролика и ещё не устарела. Без этой
  // проверки карта от предыдущего ролика размечала константный `en-US.4`
  // (SABR шлёт его всегда) как «english original» — русский ролик без меты
  // уезжал в перевод. unknown beats wrong.
  function audMapFresh(id) {
    if (!AUDMAP_VID || !AUDMAP_AT) return false;
    if (id && AUDMAP_VID !== id) return false;
    return (Date.now() - AUDMAP_AT) < 120000;
  }

  function buildAudMap(vid, fmts) {
    if (!fmts || !fmts.length) return;
    // vid может быть пустым (адрес ещё не переключился на watch) — карту всё
    // равно собираем: ключ в ней — id дорожки, а не ролик.
    if (vid && vid !== AUDMAP_VID) { AUDMAP = {}; AUDMAP_VID = vid; }
    AUDMAP_AT = Date.now();
    for (var i = 0; i < fmts.length && i < 120; i++) {
      var f = fmts[i] || {}, t = f.audioTrack || {};
      var tid = String(t.id || '');
      if (!tid) continue;
      var px = parseXtags(f.xtags);
      if (!px && AUDMAP[tid]) continue;
      AUDMAP[tid] = {
        itag: Number(f.itag) || 0,
        trackId: tid,
        acont: px ? px.acont : '',
        lang: px ? px.lang : '',
        dubbed: px ? px.dubbed : false,
        def: !!t.audioIsDefault,
        mapped: !!px
      };
    }
    try {
      once('audmap-' + vid + '-' + fmts.length, 'audmap vid=' + (vid || '-')
        + ' fmts=' + fmts.length + ' n=' + Object.keys(AUDMAP).length
        + ' keys=' + Object.keys(AUDMAP).slice(0, 6).join(','));
    } catch (e) { }
  }

  // Дорожка, объявленная в player-ответе дорожкой по умолчанию. Фактического
  // выбора плеера она не доказывает, но это самое сильное, что есть на ТВ:
  // SABR-запрос плеера id не даёт (поле 69 — константа `en-US.4`). Публикуем
  // как `phase=default`: ниже реально выбранной дорожки, но выше плана моста.
  function publishDefaultTrack(j, vid) {
    try {
      var id = (vid && /^[A-Za-z0-9_-]{11}$/.test(vid)) ? vid : (PLAYER_VID || capVideoId());
      if (!id) return;
      var atr = (j && j.captions && j.captions.playerCaptionsTracklistRenderer) || {};
      var ats = atr.audioTracks || [];
      if (!ats.length) return;
      var idx = (atr.defaultAudioTrackIndex == null) ? 0 : Number(atr.defaultAudioTrackIndex);
      var d = ats[idx] || ats[0] || {};
      var tid = String(d.audioTrackId || d.id || '');
      if (!tid) return;
      var m = AUDMAP[tid] || null;
      if (!m || !m.mapped || !m.lang) {
        once('dflt-skip-' + id + '-' + tid, 'default track vid=' + id + ' id=' + tid
          + ' unmapped=1 (not published) mapkeys='
          + Object.keys(AUDMAP).slice(0, 6).join(','));
        return;
      }
      var key = 'dflt|' + id + '|' + tid;
      if (TRACK_SENT[key]) return;
      TRACK_SENT[key] = 1;
      post('playtrack-default vid=' + id + ' id=' + tid + ' lang=' + m.lang
        + ' acont=' + (m.acont || '-') + ' dubbed=' + (m.dubbed ? 1 : 0)
        + ' itag=' + m.itag);
      sendJson('/track', {
        vid: id, trackId: tid, lang: m.lang, acont: m.acont || '',
        dubbed: m.dubbed ? 1 : 0, mapped: 1, itag: m.itag, phase: 'default'
      });
    } catch (e) { }
  }

  // Опубликовать в оверлей дорожку, которую плеер действительно стримит.
  function reportPlayingTrack(trackId, vid) {
    try {
      if (!trackId) return;
      var id = (vid && /^[A-Za-z0-9_-]{11}$/.test(vid)) ? vid : (PLAYER_VID || capVideoId());
      // Карта дорожек могла остаться от предыдущего ролика: тогда её ключи
      // (в т.ч. константный en-US.4) ничего не говорят об этом видео.
      if (!audMapFresh(id)) {
        once('playtrack-stale-' + id + '-' + trackId,
          'playtrack skip id=' + trackId + ' vid=' + id + ' stale map (vid=' + AUDMAP_VID + ')');
        return;
      }
      // Адрес страницы — независимая проверка: player-ответ мог быть от
      // preview-ролика, а SABR уже от того, что открыт на странице.
      var cur = capVideoId();
      if (cur && cur !== id) {
        once('playtrack-cur-' + cur + '-' + trackId,
          'playtrack skip id=' + trackId + ' map=' + id + ' page=' + cur + ' (mismatch)');
        return;
      }
      var m = AUDMAP[trackId] || null;
      // Только дорожка, найденная в player-ответе ЭТОГО ролика. На ТВ в поле 69
      // SABR-запроса плеер присылает постоянный `en-US.4`, которого нет ни в
      // одной карте дорожек ролика: язык из префикса id — выдумка (русский
      // оригинал считался английским и уезжал в перевод). Без маппинга молчим.
      if (!m || !m.lang) {
        once('playtrack-skip-' + id + '-' + trackId,
          'playtrack skip id=' + trackId + ' vid=' + id + ' unmapped=1 (not published)');
        return;
      }
      var lang = m.lang;
      var ti = {
        trackId: trackId,
        src: 'sabr-track',
        itag: m ? m.itag : 0,
        acont: m ? m.acont : '',
        lang: lang,
        dubbed: m ? !!m.dubbed : false,
        mapped: !!(m && m.mapped)
      };
      once('playtrack-' + id + '-' + trackId, 'playtrack vid=' + id + ' id=' + trackId
        + ' lang=' + langBaseOf(lang) + ' acont=' + (ti.acont || '-')
        + ' dubbed=' + (ti.dubbed ? 1 : 0) + ' mapped=' + (ti.mapped ? 1 : 0)
        + ' itag=' + ti.itag);
      if (window.__votAudioTrack) window.__votAudioTrack(ti, id);
      // Тот же факт — напрямую в мост: JS-хук оверлея на ТВ не срабатывает
      // (Cobalt ходит в SABR нативно), а GET /source должен отвечать всегда.
      var tk = id + '|' + trackId;
      if (id && !TRACK_SENT[tk]) {
        TRACK_SENT[tk] = 1;
        sendJson('/track', {
          vid: id, trackId: trackId, lang: lang, acont: ti.acont || '',
          dubbed: ti.dubbed ? 1 : 0, mapped: ti.mapped ? 1 : 0, itag: ti.itag
        });
      }
    } catch (e) { }
  }

  function sabrDiag(rec, bytes, status) {
    if (rec.diagDone) return;
    rec.diagDone = true;
    var parsed = status ? { status: status, id: '' } : sabrDiagParse(bytes);
    var vid = /^[A-Za-z0-9_-]{11}$/.test(rec.vid) ? rec.vid : 'unbound';
    var key = parsed.status + ':' + parsed.id;
    var now = Date.now(), prev = sabrDiagSeen[vid];
    if (prev && prev.key === key && prev.count >= 4 && now - prev.ts < 20000) return;
    sabrDiagSeen[vid] = { key: key, count: prev && prev.key === key ? prev.count + 1 : 1, ts: now };
    post('page-sabr vid=' + vid + ' capTs=' + rec.ts + ' parseTs=' + now
      + ' src=' + rec.src + ' bodyLen=' + (bytes ? bytes.length : 0)
      + ' track69=' + parsed.status + (parsed.id ? ' id=' + parsed.id : ''));
    // Дорожка найдена — сразу говорим оверлею, что играет на самом деле.
    if (parsed.id) reportPlayingTrack(parsed.id, rec.vid);
  }

  function headersToObj(h) {
    var o = {};
    if (!h) return o;
    try {
      if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) o[String(h[i][0]).toLowerCase()] = String(h[i][1]);
      } else if (typeof h.forEach === 'function') {
        h.forEach(function (v, k) { o[String(k).toLowerCase()] = String(v); });
      } else {
        for (var k in h) {
          if (Object.prototype.hasOwnProperty.call(h, k)) o[String(k).toLowerCase()] = String(h[k]);
        }
      }
    } catch (e) { }
    return o;
  }

  // Что именно приходит в теле: без этого не понять, почему захват пустой.
  function bodyDesc(body) {
    if (body === null || body === undefined) return 'null';
    var t = typeof body;
    var cn = '';
    try { cn = (body.constructor && body.constructor.name) || ''; } catch (e) { }
    var extra = '';
    try {
      if (typeof body.byteLength === 'number') extra += ' byteLength=' + body.byteLength;
      if (typeof body.size === 'number') extra += ' size=' + body.size;
      if (typeof body.length === 'number') extra += ' length=' + body.length;
      if (typeof body.type === 'string') extra += ' type=' + body.type;
    } catch (e) { }
    return t + '/' + cn + extra;
  }

  // Язык аудиодорожки, которую реально играет плеер. В URL SABR-запроса есть
  // `xtags=<base64>`, а внутри — protobuf-строка вида `acont=dubbed-auto:lang=ar`
  // или `acont=original:lang=en`. Это единственный источник, который появляется
  // уже на первом POST плеера (~1 с) — раньше InnerTube-метаданных и раньше,
  // чем мост успевает отправить звук в Яндекс. Поэтому решение «звук уже
  // русский, переводить нечего» принимается сразу, а не через 10-17 с.
  function atobStr(s) {
    try {
      if (window.atob) return atob(s);
    } catch (e) { }
    return '';
  }

  function sabrTrackInfo(url, bodyText) {
    try {
      var s = '';
      var m = /[?&]xtags=([^&]*)/.exec(String(url || ''));
      if (m) {
        var v = m[1];
        try { v = decodeURIComponent(v); } catch (e0) { }
        // base64url в URL тоже встречается.
        v = v.replace(/-/g, '+').replace(/_/g, '/');
        s = atobStr(v);
      }
      // Иногда xtags едет не в URL, а строкой в protobuf-теле POST: protobuf
      // хранит строки сырыми, поэтому ищем маркер прямо в декодированных байтах.
      if (!s && bodyText && bodyText.indexOf('acont=') >= 0) s = bodyText;
      if (!s) return null;
      if (s.indexOf('acont') < 0 && s.indexOf('lang=') < 0) return null;
      var a = /acont=([A-Za-z0-9_-]+)/.exec(s);
      var l = /lang=([A-Za-z]{2,10}(?:-[A-Za-z0-9]{2,8})?)/.exec(s);
      return { acont: a ? a[1].toLowerCase() : '',
               lang: l ? l[1].toLowerCase() : '',
               dubbed: /dubbed/i.test(s) };
    } catch (e) { return null; }
  }

  function sabrBodyBytes(body) {
    if (typeof body === 'string') return new Uint8Array(strBytes(body));
    if (body && body.buffer && typeof body.byteOffset === 'number'
        && typeof body.byteLength === 'number') {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body && typeof body.byteLength === 'number') return new Uint8Array(body);
    return null;
  }

  function finishSabrBody(rec, body) {
    if (rec.diagDone) return;
    var bytes = null;
    try { bytes = sabrBodyBytes(body); } catch (e) { }
    if (!bytes) { sabrDiag(rec, null, 'unavailable'); return; }
    if (bytes.length > SABR_MAX) { sabrDiag(rec, null, 'oversize'); return; }
    sabrDiag(rec, bytes, bytes.length ? '' : 'empty-body');
    if (bytes.length && SABR === rec) {
      rec.body = b64buf(bytes);
      SABR_BODY = '';
      sendSabr();
    }
  }

  function rememberSabr(u, headers, body, method, src, deferred, capTs, capVid) {
    var h = headersToObj(headers);
    // Content-Length браузер ставит сам, в наборе он не нужен.
    delete h['content-length'];
    var rec = { url: String(u || ''), headers: h, body: '',
                method: String(method || 'GET').toUpperCase(),
                ts: capTs === undefined ? Date.now() : capTs,
                vid: capVid === undefined ? capVideoId() : capVid, src: src || '?' };
    SABR = rec;
    once('sabrcap' + (src || ''), 'sabr-req[' + (src || '?') + '] m=' + rec.method
      + ' len=' + rec.url.length + ' body=' + rec.body.length
      + ' bdesc=' + bodyDesc(body) + ' hdr=' + Object.keys(h).join('|'));
    reportTrack(rec.url, '');
    if (body !== null && body !== undefined) {
      try {
        if (body && typeof body.arrayBuffer === 'function' && !sabrBodyBytes(body)) {
          body.arrayBuffer().then(function (ab) { finishSabrBody(rec, ab); },
            function () { sabrDiag(rec, null, 'unavailable'); });
        } else finishSabrBody(rec, body);
      } catch (e) { sabrDiag(rec, null, 'unavailable'); }
    } else if (!deferred) sabrDiag(rec, null, 'unavailable');
    sendSabr();
    return rec;
  }

  // Опубликовать язык звучащей дорожки в основной скрипт. `text` — сырые байты
  // тела SABR (protobuf хранит строки открыто), `url` — адрес запроса.
  function reportTrack(url, text) {
    try {
      // Диагностика «где лежит дорожка»: отдельные строки для URL и для тела —
      // тело приходит позже (клон Request), и пустое тело ничего не доказывает.
      once(text ? 'trackdiag-body' : 'trackdiag', 'trackdiag'
        + (text ? '-body' : '') + ' qp=' + (function (u) {
        var out = [], mm = /[?&]([a-z0-9_]+)=/gi, x;
        while ((x = mm.exec(String(u || ''))) && out.length < 14) out.push(x[1]);
        return out.join(',');
      })(url)
        + ' xtagUrl=' + (/([?&])xtags=/.test(String(url || '')) ? 1 : 0)
        + ' inLen=' + text.length
        + ' acontBody=' + (text.indexOf('acont=') >= 0 ? 1 : 0)
        + ' dubbedBody=' + (text.indexOf('dubbed') >= 0 ? 1 : 0)
        + ' langBody=' + (text.indexOf('lang=') >= 0 ? 1 : 0));
      var ti = sabrTrackInfo(url, text);
      if (ti && (ti.lang || ti.acont)) {
        var vid = capVideoId();
        once('audiotrack-' + vid, 'audiotrack vid=' + vid + ' acont=' + ti.acont
          + ' lang=' + ti.lang + ' dubbed=' + (ti.dubbed ? 1 : 0));
        if (window.__votAudioTrack) window.__votAudioTrack(ti, vid);
      }
    } catch (e2) { }
  }

  // Отдать запрос мосту. Плеер постит SABR часто, поэтому не чаще раза в 3 с и
  // только если тело изменилось (rn в URL меняется, тело — нет).
  var SABR_TS = 0, SABR_BODY = '';

  function sendSabr() {
    if (!SABR) return;
    // Тело плеера приходит асинхронно (клон Request), поэтому разбираем дорожку
    // здесь: в теле лежат selectedFormatIds, а в них — xtags звучащей дорожки
    // (`acont=dubbed-auto:lang=xx`), даже когда в URL xtags нет вовсе.
    try {
      var btxt = '';
      if (SABR.body) { try { btxt = atobStr(SABR.body); } catch (e4) { } }
      reportTrack(SABR.url, btxt);
    } catch (e5) { }
    var now = Date.now();
    if (now - SABR_TS < 3000 && SABR.body === SABR_BODY) return;
    SABR_TS = now;
    SABR_BODY = SABR.body;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + '/sabrreq', true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(JSON.stringify(SABR));
    } catch (e) { }
  }

  window.__votSabrReq = function () { return SABR; };

  // Что плеер реально получает в ответ: набор типов UMP-кадров. Без этого
  // нельзя отличить «наш запрос неверный» от «сервер вообще не отдаёт медиа».
  function umpScan(u8) {
    var out = {};
    var pos = 0;
    function rv() {
      var start = pos, first = u8[pos++], size = first < 128 ? 1 : first < 192 ? 2
        : first < 224 ? 3 : first < 240 ? 4 : 5;
      var r = 0, shift = 0;
      if (size !== 5) { shift = 8 - size; r = first & ((1 << shift) - 1); }
      for (var i = 1; i < size; i++) { r += u8[pos++] * Math.pow(2, shift); shift += 8; }
      if (pos > u8.length) { pos = start; return -1; }
      return r;
    }
    for (var n = 0; n < 4000 && pos < u8.length; n++) {
      var t = rv();
      if (t < 0) break;
      var s = rv();
      if (t < 0 || s < 0 || pos + s > u8.length) break;
      out[t] = (out[t] || 0) + 1;
      pos += s;
    }
    var parts = [];
    for (var k in out) if (Object.prototype.hasOwnProperty.call(out, k)) parts.push(k + '=' + out[k]);
    return parts.join(',');
  }

  function hexHead(u8, n) {
    var s = '';
    var lim = Math.min(n, u8.length);
    for (var i = 0; i < lim; i++) {
      if (i) s += ' ';
      var v = u8[i];
      s += (v < 16 ? '0' : '') + v.toString(16);
    }
    return s;
  }

  var SABR_RESP_N = 0;

  function sabrRespBuf(buf) {
    try {
      var u8 = new Uint8Array(buf);
      if (!u8.length || SABR_RESP_N >= 3) return;
      SABR_RESP_N++;
      post('sabr-resp len=' + u8.length + ' parts=' + umpScan(u8)
        + ' hex=' + hexHead(u8, 24));
    } catch (e) { }
  }

  function sabrResp(xhr) {
    try {
      var r = xhr.response;
      if (!r) return;
      if (typeof r === 'string') return;
      sabrRespBuf(r);
    } catch (e) { }
  }

  // ---- конфиг SABR из player-ответа самой страницы -------------------------
  // Мост минтит собственный player-ответ чужим клиентом, и SABR-сервер на его
  // тело отвечает `sabr.malformed_config`. Поэтому берём ровно тот конфиг,
  // которым плеер играет прямо сейчас: url, videoPlaybackUstreamerConfig и
  // формат (itag/lmt/clen) аудио.
  var SABRCFG = null;

  function sendJson(path, obj) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + path, true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(JSON.stringify(obj));
    } catch (e) { }
  }

  // Диагностика дорожек из ответа плеера. defaultAudioTrackIndex и
  // defaultAudioLanguage — подсказки, НЕ доказательство выбранного звука или
  // оригинала (например, en-US.10 + ru.4 с default=ru). Не управлять ими
  // автостартом/skip: для этого нужен язык фактически выбранной дорожки.
  function trackLang(j) {
    var out = { lang: '', src: '', ids: '', n: 0, def: -1, caps: '', vd: '', asr: '' };
    try {
      var vdd = (j && j.videoDetails) || {};
      out.vd = String(vdd.defaultAudioLanguage || '');
      if (out.vd) { out.lang = out.vd; out.src = 'vdlang'; }
    } catch (e0) { }
    try {
      var atr = (j && j.captions && j.captions.playerCaptionsTracklistRenderer) || {};
      var ats = atr.audioTracks || [];
      out.n = ats.length;
      out.def = (atr.defaultAudioTrackIndex == null) ? -1 : atr.defaultAudioTrackIndex;
      var ids = [], i;
      for (i = 0; i < ats.length && i < 6; i++) {
        ids.push(String(ats[i].audioTrackId || ats[i].id || '?'));
      }
      out.ids = ids.join(',');
      var cts = atr.captionTracks || [], caps = [];
      for (i = 0; i < cts.length && i < 5; i++) caps.push(String(cts[i].languageCode || '?'));
      out.caps = caps.join(',');
      // ASR-субтитры распознаны ИЗ САМОГО ЗВУКА — их язык и есть язык дорожки.
      // Ручные субтитры авторские (могут быть переводом), поэтому не годятся.
      // Это тот же принцип, что в мосте (captions-asr = MEDIUM-подсказка), но
      // здесь ответ плеера уже под рукой: /meta_local часто отвечает
      // LOGIN_REQUIRED и язык не определялся вовсе.
      for (i = 0; i < cts.length && i < 20; i++) {
        var c = cts[i] || {};
        var vss = String(c.vssId || '');
        if (String(c.kind || '') !== 'asr' && vss.indexOf('a-') !== 0) continue;
        var cl = langBaseOf(c.languageCode);
        if (cl && cl !== 'und') { out.asr = cl; break; }
      }
      if (out.asr) { out.lang = out.asr; out.src = 'captions-asr'; }
      else if (out.vd) { out.lang = out.vd; out.src = 'vdlang'; }
      // Дефолтный индекс дорожки не доказывает ни выбор, ни оригинальность
      // (en-US.10 + ru.4 с default=ru), поэтому из audioTracks язык не берём.
      var dflt = (out.def >= 0 && ats[out.def]) ? ats[out.def] : null;
      var tid = dflt ? String(dflt.audioTrackId || dflt.id || '') : '';
      if (tid && !out.lang) { out.lang = tid.split('.')[0]; out.src = 'audioTracks'; }
    } catch (e1) { }
    return out;
  }

  function rememberPlayerJson(j) {
    try {
      var ti = String((j && j.videoDetails && j.videoDetails.videoId) || capVideoId() || '');
      if (ti) PLAYER_VID = ti;
      var tl = trackLang(j);
      once('audtrk-' + ti, 'audtrk vid=' + ti + ' n=' + tl.n + ' def=' + tl.def
        + ' ids=' + (tl.ids || '-') + ' caps=' + (tl.caps || '-')
        + ' vdlang=' + (tl.vd || '-') + ' -> hint=' + (tl.lang || '?')
        + ' src=' + (tl.src || '-') + ' (not selected)');
      // Даже один объявленный трек не доказывает выбор плеера. До подтверждения
      // фактическим аудиозапросом не вызывать __votMetaLang/skip/auto-start.
      // Исключение — язык, который не является догадкой о выборе дорожки:
      // ASR-субтитры (распознаны из звука) и defaultAudioLanguage из ответа
      // плеера. Только они уходят в оверлей как подсказка MEDIUM.
      if (tl.lang && (tl.src === 'captions-asr' || tl.src === 'vdlang')) {
        try {
          if (window.__votMetaLang) window.__votMetaLang(ti, tl.lang, 'player-' + tl.src);
        } catch (e8) { }
      }
    } catch (e5) { }
    try {
      var sd = (j && j.streamingData) || null;
      var fmts = (sd && sd.adaptiveFormats) || [];
      // Карта «audioTrackId → роль/язык» для этого ролика: по ней SABR-запрос
      // плеера (в нём есть только id) превращается в «играет en-US, дубль».
      // Строим до проверки serverAbrStreamingUrl: роль дорожки нужна и для
      // ответов без SABR (её публикует publishDefaultTrack).
      try { buildAudMap(ti || capVideoId(), fmts); } catch (e6) { post('audmap ERR ' + e6 + ' vid=' + ti); }
      try { publishDefaultTrack(j, ti); } catch (e7) { }
      if (!sd || !sd.serverAbrStreamingUrl) return;
      var mc = ((j.playerConfig || {}).mediaCommonConfig) || {};
      var ur = mc.mediaUstreamerRequestConfig || {};
      var ucfg = String(ur.videoPlaybackUstreamerConfig || '');
      // Диагностика выбора дорожки: TV-плеер уходит в автодуб
      // (`acont=dubbed-auto:lang=xx`), и мы получаем медиа дубля, а не
      // оригинала. Список аудиоформатов с xtags/audioTrack показывает, есть ли
      // в ответе оригинальная дорожка и как она называется.
      try {
        var vdId = ti || capVideoId() || '?';
        var desc = [];
        for (var k = 0; k < fmts.length && desc.length < 8; k++) {
          var q = fmts[k] || {};
          var qi = Number(q.itag) || 0;
          if (qi < 139 || qi > 251) continue;
          var qx = String(q.xtags || '');
          var qt = q.audioTrack || {};
          desc.push(qi + (qx ? '[' + qx + ']' : '[-]')
            + (qt.id ? '{' + String(qt.id).slice(0, 24) + (qt.audioIsDefault ? '*D' : '') + '}' : ''));
        }
        var dt = -1;
        try {
          var atr = j.captions.playerCaptionsTracklistRenderer || {};
          dt = atr.defaultAudioTrackIndex;
        } catch (e2) { }
        once('audfmt-' + vdId, 'audfmt vid=' + vdId + ' def=' + dt
          + ' ' + desc.join(' '));
      } catch (e3) { }
      var best = null;
      for (var i = 0; i < fmts.length; i++) {
        var f = fmts[i] || {};
        var itag = Number(f.itag) || 0;
        var mime = String(f.mimeType || '');
        var audio = mime.indexOf('audio/') === 0 || (itag >= 139 && itag <= 141)
          || itag === 249 || itag === 250 || itag === 251;
        if (!audio) continue;
        var score = itag === 140 ? 100 : itag === 251 ? 80 : itag === 250 ? 70
          : itag === 249 ? 60 : itag === 139 ? 50 : 10;
        if (!best || score > best.score) best = { score: score, f: f, itag: itag };
      }
      if (!best) return;
      var bf = best.f;
      SABRCFG = {
        url: String(sd.serverAbrStreamingUrl),
        ucfg: ucfg,
        itag: best.itag,
        lmt: String(bf.lastModified || ''),
        clen: String(bf.contentLength || ''),
        xtags: String(bf.xtags || ''),
        vd: window.__votVisitorData(),
        vid: (ti || capVideoId())
      };
      once('sabrcfg', 'sabr-cfg urlLen=' + SABRCFG.url.length + ' ucfg=' + ucfg.length
        + ' itag=' + SABRCFG.itag + ' clen=' + SABRCFG.clen + ' vd=' + SABRCFG.vd.length);
      sendJson('/sabrcfg', SABRCFG);
    } catch (e) { }
  }

  window.__votSabrCfg = function () { return SABRCFG; };

  // Ещё наружу: visitor id страницы. InnerTube из Java отвечает
  // LOGIN_REQUIRED («confirm you're not a bot»), а этот id у плеера рабочий —
  // мост минтит poToken уже под него.
  window.__votVisitorData = function () {
    try {
      if (window.ytcfg && ytcfg.get) {
        var vd = ytcfg.get('VISITOR_DATA');
        if (vd) return String(vd);
        var pv = ytcfg.get('PLAYER_VARS');
        if (pv && pv.visitorData) return String(pv.visitorData);
      }
    } catch (e) { }
    return '';
  };

  // Короткая сводка языков субтитров: «en:asr,en:manual».
  function capsBrief(j) {
    try {
      var atr = (j && j.captions && j.captions.playerCaptionsTracklistRenderer) || {};
      var ct = atr.captionTracks || [], out = [];
      for (var i = 0; i < ct.length && i < 4; i++) {
        var c = ct[i] || {};
        out.push(String(c.languageCode || '?') + ':'
          + (String(c.kind || '') === 'asr' ? 'asr' : 'manual'));
      }
      return out.length ? out.join(',') : '-';
    } catch (e) { return '-'; }
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
    rememberPlayerJson(j);
  }

  // Поиск: только узкий InnerTube endpoint. Текст запроса, тело и headers
  // остаются в памяти страницы; в /log уходят лишь фиксированные признаки.
  var searchLastQuery = null, searchTraces = 0;
  function searchKind(u) {
    var s = String(u || '');
    if (/(?:^|\/)youtubei\/v1\/search(?:[?#]|$)/.test(s)) return 'inner';
    if (/(?:^|\/)search(?:[?#]|$)/.test(s) || /(?:^|\/)results(?:[?#]|$)/.test(s)) return 'other';
    return '';
  }
  // Одно целое из префа в диапазоне 0..max; всё остальное — 0 (без фильтра).
  function searchPick(key, max) {
    var n = 0;
    try { n = Number(window.VOTUI && VOTUI.pref(key, 0)); } catch (e) { }
    return n >= 0 && n <= max && Math.floor(n) === n ? n : 0;
  }
  // Поля protobuf params: 1 — сортировка, 2.1 — дата, 2.2 — тип, 2.3 — длина.
  function searchDate() { return searchPick('search.date', 5); }
  function searchSort() { return searchPick('search.sort', 3); }
  function searchType() { return searchPick('search.type', 4); }
  function searchDuration() { return searchPick('search.duration', 2); }
  function pbReadVar(b, i) {
    var n = 0, v = 0;
    while (i < b.length && n < 10) {
      var x = b[i++];
      v += (x & 127) * Math.pow(2, 7 * n++);
      if (!(x & 128)) return { value: v, end: i };
    }
    return null;
  }
  function pbVar(n) {
    var a = [];
    do { var x = n % 128; n = Math.floor(n / 128); a.push(x | (n ? 128 : 0)); } while (n);
    return a;
  }
  function pbFields(b) {
    var fields = [], i = 0;
    while (i < b.length) {
      var start = i, tag = pbReadVar(b, i);
      if (!tag || !tag.value || tag.value > 16383) return null;
      i = tag.end;
      var wire = tag.value % 8, data = i, len;
      if (wire === 0) {
        var val = pbReadVar(b, i);
        if (!val) return null;
        i = val.end;
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        len = pbReadVar(b, i);
        if (!len || len.value > 512) return null;
        data = len.end;
        i = data + len.value;
      } else return null;
      if (i > b.length) return null;
      fields.push({ number: Math.floor(tag.value / 8), wire: wire,
        start: start, data: data, end: i });
    }
    return fields;
  }
  function pbAppend(dst, src, start, end) {
    for (var i = start; i < end; i++) dst.push(src[i]);
  }
  // Собираем params из четырёх групп фильтров, не стирая прочие protobuf-поля.
  // Поле 2 разбираем, выкидываем 2.1/2.2/2.3 и пишем их заново; features (2.4+)
  // и неизвестные подполя копируются байт в байт. Если формат иной — отказ (null).
  function searchParams(raw) {
    if (raw !== undefined && typeof raw !== 'string') return null;
    var sort = searchSort(), date = searchDate(),
      type = searchType(), dur = searchDuration();
    if (!raw && !sort && !date && !type && !dur) return '';
    var b = [];
    try {
      var s = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
      if (s.length > 720 || s.length % 4 === 1) return null;
      var decoded = atob(s);
      if (decoded.length > 512) return null;
      for (var i = 0; i < decoded.length; i++) b.push(decoded.charCodeAt(i));
    } catch (e) { return null; }
    var top = pbFields(b);
    if (!top) return null;
    var out = [], head = [], found1 = false, found2 = false;
    for (var t = 0; t < top.length; t++) {
      var f = top[t];
      if (f.number === 1) {
        if (f.wire !== 0 || found1) return null;
        found1 = true;
        continue; // значение задаёт преф
      }
      if (f.number !== 2 || f.wire !== 2) {
        pbAppend(out, b, f.start, f.end);
        continue;
      }
      if (found2) return null;
      found2 = true;
      var nested = b.slice(f.data, f.end), fields = pbFields(nested), kept = [], body = [];
      if (!fields) return null;
      for (var j = 0; j < fields.length; j++) {
        var g = fields[j];
        if (g.number >= 1 && g.number <= 3) {
          if (g.wire !== 0) return null;
          continue; // 2.1/2.2/2.3 задаются префами
        }
        pbAppend(kept, nested, g.start, g.end);
      }
      // Свои подполя пишем по возрастанию номеров (2.4+ идут следом как есть).
      if (date) pbAppend(body, [8, date], 0, 2);
      if (type) pbAppend(body, [16, type], 0, 2);
      if (dur) pbAppend(body, [24, dur], 0, 2);
      for (var k = 0; k < kept.length; k++) body.push(kept[k]);
      if (body.length) {
        pbAppend(out, [18], 0, 1);
        pbAppend(out, pbVar(body.length), 0, pbVar(body.length).length);
        pbAppend(out, body, 0, body.length);
      }
    }
    if (!found2) {
      var own = [];
      if (date) pbAppend(own, [8, date], 0, 2);
      if (type) pbAppend(own, [16, type], 0, 2);
      if (dur) pbAppend(own, [24, dur], 0, 2);
      if (own.length) {
        pbAppend(out, [18], 0, 1);
        pbAppend(out, pbVar(own.length), 0, pbVar(own.length).length);
        pbAppend(out, own, 0, own.length);
      }
    }
    if (sort) { head.push(8, sort); }
    try {
      return btoa(String.fromCharCode.apply(null, head.concat(out)));
    } catch (e) { return null; }
  }
  function searchBody(body) {
    if (typeof body !== 'string' || body.length > 100000) return null;
    try {
      var j = JSON.parse(body);
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch (e) { return null; }
  }
  function searchRewrite(body) {
    var j = searchBody(body);
    if (!j || typeof j.query !== 'string' || !j.query || j.continuation) return null;
    var next = searchParams(j.params);
    if (next === null) return null;
    if (next === (j.params || '')) return null;
    if (next) j.params = next;
    else delete j.params;
    return JSON.stringify(j);
  }
  function searchTrace(kind, transport, method, body, rewritten) {
    if (!kind || searchTraces++ >= 12) return;
    var j = searchBody(body), q = j && typeof j.query === 'string' ? j.query : null;
    var same = q === null || searchLastQuery === null ? '-' : (searchLastQuery === q ? '1' : '0');
    if (q !== null) searchLastQuery = q;
    post('search ' + transport + ' ' + String(method || 'GET').toUpperCase().slice(0, 8) +
      ' kind=' + kind + ' query=' + (q !== null ? 1 : 0) +
      ' params=' + (j && typeof j.params === 'string' ? 1 : 0) +
      ' continuation=' + (j && j.continuation ? 1 : 0) +
      ' same=' + same + ' sort=' + searchSort() + ' date=' + searchDate() +
      ' type=' + searchType() + ' dur=' + searchDuration() +
      ' rewrite=' + (rewritten ? 1 : 0));
  }

  function patchXhr() {
    var P = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (!P || P.__votNet) return !!P;
    var oOpen = P.open, oSend = P.send, oHdr = P.setRequestHeader;
    P.open = function (m, u) {
      try { this.__votU = String(u || ''); this.__votH = {}; this.__votM = String(m || 'GET'); } catch (e) { }
      return oOpen.apply(this, arguments);
    };
    if (oHdr) {
      P.setRequestHeader = function (k, v) {
        try { (this.__votH = this.__votH || {})[String(k).toLowerCase()] = String(v); } catch (e) { }
        return oHdr.apply(this, arguments);
      };
    }
    P.send = function () {
      var u = '';
      try { u = this.__votU || ''; } catch (e) { }
      var kind = searchKind(u);
      if (kind) {
        var original = arguments.length ? arguments[0] : null;
        var changed = kind === 'inner' ? searchRewrite(original) : null;
        searchTrace(kind, 'xhr', this.__votM, original, changed !== null);
        if (changed !== null) arguments[0] = changed;
      }
      netLog('xhr', u);
      if (isSabr(u)) {
        try {
          rememberSabr(u, this.__votH, arguments.length ? arguments[0] : null, this.__votM, 'xhr');
          var sx = this;
          try { sx.addEventListener('loadend', function () { sabrResp(sx); }); } catch (e) { }
        } catch (e) { }
      } else if (isPlayer(u)) {
        var self = this;
        try { this.addEventListener('loadend', function () { onPlayer(self); }); } catch (e) { }
      } else if (String(u).indexOf('googlevideo.com') >= 0) {
        try { rememberAudio(u); } catch (e) { }
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
      var sabr = false;
      try { sabr = isSabr(u); } catch (e) { }
      // Клон Request надо брать ДО отправки: после неё тело уже залочено на
      // чтение, и `arrayBuffer()` не отдаёт ничего. Плеер постит SABR именно
      // Request-объектом, поэтому без этого тело не снять.
      var init = arguments.length > 1 ? arguments[1] : null;
      var kind = searchKind(u), searchClone = null;
      if (kind) {
        var original = init && init.body;
        if (original === undefined || original === null) {
          try { if (input && typeof input.clone === 'function') searchClone = input.clone(); } catch (e) { }
        }
        var changed = kind === 'inner' ? searchRewrite(original) : null;
        if (changed !== null) {
          var nextInit = {};
          for (var key in init) if (Object.prototype.hasOwnProperty.call(init, key)) nextInit[key] = init[key];
          nextInit.body = changed;
          arguments[1] = init = nextInit;
        }
        if (!searchClone) searchTrace(kind, 'fetch', (init && init.method) || (input && input.method),
          original, changed !== null);
      }
      var hasInitBody = !!(init && init.body !== null && init.body !== undefined);
      var capTs = sabr ? Date.now() : 0;
      var capVid = sabr ? capVideoId() : '';
      var keep = null;
      if (sabr && !hasInitBody) {
        try {
          if (input && typeof input.clone === 'function') keep = input.clone();
        } catch (e) { }
      }
      var p;
      try {
        p = of.apply(this, arguments);
      } catch (e) {
        throw e;
      }
      netLog('fetch', u);
      if (searchClone) {
        // Request без init.body диагностируем асинхронно, но не меняем:
        // реконструкция чужого Request может потерять режим/credentials.
        try {
          searchClone.text().then(function (text) {
            searchTrace(kind, 'request', (init && init.method) || (input && input.method), text, false);
          }, function () { searchTrace(kind, 'request', (init && init.method) || (input && input.method), null, false); });
        } catch (e) { }
      }
      try {
        if (sabr) {
          try {
            var mn = (init && init.method) || (input && input.method) || 'GET';
            var rec = rememberSabr(u, init && init.headers,
              hasInitBody ? init.body : null, mn, 'fetch', !!keep, capTs, capVid);
            if (keep) {
              try {
                keep.arrayBuffer().then(function (ab) { finishSabrBody(rec, ab); },
                  function () { sabrDiag(rec, null, 'unavailable'); });
              } catch (e) { sabrDiag(rec, null, 'unavailable'); }
            }
            p.then(function (r) {
              try {
                r.clone().arrayBuffer().then(sabrRespBuf);
              } catch (e) { }
            });
          } catch (e) { }
        } else if (isPlayer(u)) {
          p.then(function (r) {
            try {
              r.clone().text().then(function (t) {
                var j = null;
                try { j = JSON.parse(t); } catch (e) { return; }
                var ps = (j && j.playabilityStatus) || {};
                // Ключ per-vid: иначе вторая и последующие страницы роликов
                // выглядят как «ответа плеера нет», и непонятно, видит ли хук
                // watch-проигрывание вообще.
                var pv = String((j && j.videoDetails && j.videoDetails.videoId) || '?');
                once('fplayer-' + pv, 'fetch player vid=' + pv
                  + ' len=' + t.length + ' status=' + (ps.status || '?') + ' '
                  + countFmts(j) + ' caps=' + capsBrief(j) + ' vd='
                  + String(((j && j.videoDetails) || {}).defaultAudioLanguage || '-'));
                rememberPlayerJson(j);
              });
            } catch (e) { }
          });
        } else if (String(u).indexOf('googlevideo.com') >= 0) {
          try { rememberAudio(u); } catch (e) { }
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
      rememberPlayerJson(j);
    } catch (e) {
      once('cfg-err', 'ytcfg player_response parse err len=' + raw.length);
    }
  }

  // Отправка перехваченных байтов в мост: /cap/begin (init), /cap/chunk, /cap/end.
  // Очередь строго последовательная (begin должен лечь первым), буфер ограничен,
  // при переполнении чанки дропаются — плеер важнее.
  // Потолок файла. Предзахвата больше нет (полный трек берётся прямой докачкой
  // в мосте, см. /audiosrc), поэтому захват — только аварийный фолбэк: держим
  // потолок и буфер маленькими, чтобы не выедать память ТВ.
  var CAP_LIMIT = 24 * 1024 * 1024;
  var CAP_QBUF = 8 * 1024 * 1024;
  // Захват включается только конфигом моста (audioMode:"capture"): он копирует
  // каждый аудиосегмент и держит до 24 МБ в кэше ТВ, а нужен редко.
  var CAP_ON = false;
  // A/B: заставить плеер взять AAC (itag 140) вместо opus, даже без захвата.
  // SABR-replay отдаёт тот формат, который выбрал плеер: с opus мы получаем
  // webm/opus, а Яндексу нужен mp4/aac.
  var AAC_ON = false;
  var CAP = { vid: '', started: 0, sent: 0, qbytes: 0, q: [], busy: 0, dropped: 0,
              done: 0, endSent: 0, endWhy: '' };

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
    if (!bytes || !bytes.length) return;
    var id = capVideoId();
    if (!id) return;
    // Новый ролик — сброс ДО проверки CAP.done: иначе после закрытия файла по
    // лимиту следующий ролик остался бы вообще без захвата.
    if (id !== CAP.vid) {
      CAP.vid = id;
      CAP.started = 1;
      CAP.sent = bytes.length;
      CAP.dropped = 0;
      CAP.done = 0;
      CAP.endSent = 0;
      CAP.endWhy = '';
      CAP.q.length = 0;
      CAP.qbytes = 0;
      var init = bytes;
      capSend('/cap/begin?videoId=' + encodeURIComponent(id), init, function (r) {
        post('cap begin vid=' + id + ' init=' + init.length + ' r=' + String(r).slice(0, 70));
        capNext();
      });
      return;
    }
    // Дальше — только тот же ролик: после лимита файл закрыт.
    if (CAP.done) return;
    if (CAP.sent + bytes.length > CAP_LIMIT) {
      CAP.done = 1;
      CAP.endSent = 1;
      CAP.endWhy = 'limit';
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
  // Init-сегмент трека отдаём мосту (POST /mseinit). SABR отдаёт сессии, которая
  // трек уже играла, только media-фрагменты: ни ftyp/moov (mp4), ни заголовка
  // WebM в ответе нет, и без них файл вообще не контейнер — Яндекс отвечает
  // «Видео слишком длинное». Плеер получает init из player response и кладёт его
  // первым appendBuffer в аудио-SourceBuffer, что мы здесь и забираем.
  function mseInitSend(bytes, mime) {
    try {
      if (!bytes || !bytes.length) return;
      var q = '?vid=' + encodeURIComponent(capVideoId())
        + '&mime=' + encodeURIComponent(String(mime || '').slice(0, 80));
      capSend('/mseinit' + q, bytes, function (r) {
        post('mseinit sent ' + bytes.length + 'B r=' + String(r).slice(0, 70));
      });
    } catch (e) { }
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
              var initSent = 0;
              sb.appendBuffer = function (buf) {
                try {
                  var n = (buf && (buf.byteLength || buf.length)) || 0;
                  MSE.ap++;
                  MSE.bytes += n;
                  capPush(capBytes(buf));
                  if (!initSent) {
                    initSent = 1;
                    MSE.init = n;
                    post('mse first append ' + n + 'B mime=' + String(m).slice(0, 40));
                    mseInitSend(capBytes(buf), String(m));
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
    // Принудительный AAC нужен только захвату (путь E) или A/B-флагу `aac`.
    // При audioMode:"off" и без флага выбор кодека плеера не трогаем: иначе мы
    // отбираем opus у обычного воспроизведения без всякой пользы.
    if (!CAP_ON && !AAC_ON) return 0;
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

  // Чёрный экран на magritte: YouTube выбирает AV1 (`codec: av1` в
  // VideoDecoderConfig), а аппаратный декодер этого бокса кадры не отдаёт —
  // `VDA: VIDIOC_QBUF FAILED Invalid argument(22)`, `NotifyError:error=4`,
  // поток циклично video_decoder start/destroy. Звук при этом идёт, поэтому
  // выглядит как «ролик играет без картинки». Отказываем плееру в av01, чтобы
  // он взял VP9/H.264. Флаг `av1` в /config (true) возвращает как было.
  var AV1_ALLOW = false;
  // VP9 на этом боксе тоже отдаёт чёрный кадр (`E/OMXNodeInstance:
  // getConfig(…amlogic.vp9.decoder.awesome2…) ERROR: UnsupportedSetting`), а
  // H.264 работает: `avc1.640028` 1920x1080, `CreateVideoMediaCodec avc`,
  // `kSbPlayerStatePresenting`, ошибок декодера нет. Поэтому по умолчанию
  // просим у плеера только H.264; 'auto' — вернуть выбор ему.
  var VC_PREF = 'avc';

  function isAv1(s) {
    return String(s || '').toLowerCase().indexOf('av01') >= 0;
  }

  function isVp9(s) {
    return VC_PREF === 'avc' && /vp0?9/.test(String(s || '').toLowerCase());
  }

  // Общий отказ: av01 (если не разрешён) и vp9 (если попросили avc).
  function denyCodec(m) {
    if (!AV1_ALLOW && isAv1(m)) return 'av1';
    if (isVp9(m)) return 'vp9';
    return '';
  }

  function patchVideoCodecs() {
    var rc = 0;
    try {
      var MS = window.MediaSource;
      if (MS && MS.isTypeSupported && !MS.__votVcodec) {
        var oms = MS.isTypeSupported;
        MS.isTypeSupported = function (m) {
          var no = denyCodec(m);
          if (no) {
            once('codec-' + no, 'codec reject ' + no + ' ' + String(m).slice(0, 60));
            return false;
          }
          return oms.apply(MS, arguments);
        };
        MS.__votVcodec = 1;
        rc |= 1;
      }
    } catch (e) { }
    try {
      var V = window.HTMLVideoElement && HTMLVideoElement.prototype;
      if (V && V.canPlayType && !V.__votVcodec) {
        var ovp = V.canPlayType;
        V.canPlayType = function (t) {
          if (denyCodec(t)) return '';
          return ovp.apply(this, arguments);
        };
        V.__votVcodec = 1;
        rc |= 2;
      }
    } catch (e) { }
    try {
      var mc = navigator.mediaCapabilities;
      if (mc && mc.decodingInfo && !mc.__votVcodec) {
        var odi = mc.decodingInfo.bind(mc);
        mc.decodingInfo = function (cfg) {
          var v = cfg && cfg.video;
          var ct = (v && v.contentType) || (cfg && cfg.type) || '';
          if (denyCodec(ct)) {
            once('codec-mc-' + denyCodec(ct), 'codec reject ' + denyCodec(ct)
              + ' (mc) ' + String(ct).slice(0, 60));
            return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
          }
          return odi(cfg);
        };
        mc.__votVcodec = 1;
        rc |= 4;
      }
    } catch (e) { }
    return rc;
  }

  function report() {
    var pir = 0, cfg = 0, mse = 0;
    try { pir = window.ytInitialPlayerResponse ? 1 : 0; } catch (e) { }
    try { cfg = (window.ytcfg && ytcfg.get) ? 1 : 0; } catch (e) { }
    try { mse = window.MediaSource ? 1 : 0; } catch (e) { }
    post('boot pir=' + pir + ' ytcfg=' + cfg + ' mse=' + mse
      + ' xhr=' + (patchXhr() ? 1 : 0) + ' fetch=' + (patchFetch() ? 1 : 0)
      + ' mseh=' + (hookMse() ? 1 : 0) + ' codec=' + (patchCodecs() ? 1 : 0)
      + ' vcodec=' + patchVideoCodecs());
  }

  report();
  tryYtcfg();

  // Захват в MSE (путь E) включаем только если конфиг моста этого просит.
  // Конфиг перечитываем и позже (см. цикл ниже): флаг `aac` включают уже после
  // старта приложения, а документ к тому моменту загружен и больше /config не
  // запрашивает.
  var pullInFlight = 0;
  function pullConfig() {
    // Один запрос за раз: притормозивший мост иначе накопит XHR-ы, и поздний
    // ответ перезапишет свежий флаг устаревшим.
    if (pullInFlight) return;
    pullInFlight = 1;
    try {
      var cx = new XMLHttpRequest();
      cx.open('GET', BRIDGE + '/config', true);
      cx.onreadystatechange = function () {
        if (cx.readyState !== 4) return;
        pullInFlight = 0;
        if (cx.status !== 200) return;
        try {
          var cj = JSON.parse(cx.responseText) || {};
          var wasAac = AAC_ON;
          CAP_ON = cj.audioMode === 'capture';
          AAC_ON = !!cj.aac;
          if (AAC_ON !== wasAac) post('cfg aac=' + (AAC_ON ? 1 : 0) + ' cap=' + (CAP_ON ? 1 : 0));
          // AV1 по умолчанию отключён (чёрный экран на этом боксе): /config
          // {"av1":true} возвращает выбор видеокодека плееру.
          if (typeof cj.av1 !== 'undefined') AV1_ALLOW = cj.av1 === true;
          // Выбор видеокодека: 'avc' — оставить только H.264 (бокс не отдаёт
          // кадры для vp9 так же, как для av1). Значение применяется на лету.
          if (typeof cj.vcodec === 'string' && cj.vcodec) VC_PREF = cj.vcodec;
          // Язык-исключение можно задать из /config (сервисный рычаг): пустая
          // строка — страница пользуется своей настройкой.
          try {
            var sl = String(cj.skipLang || '');
            if (sl && sl !== window.__votSkipLang) {
              window.__votSkipLang = sl;
              if (window.__votSetSkipLang) window.__votSetSkipLang(sl);
            }
          } catch (e1) { }
          // Ручной выбор озвучки из /config (сервисный рычаг для проверок).
          try {
            var dp = String(cj.dubPick || '');
            if (dp && dp !== window.__votDubPick) {
              window.__votDubPick = dp;
              if (window.__votPickDub) window.__votPickDub(dp);
            }
          } catch (e2) { }
        } catch (e) { }
        if (AAC_ON) patchCodecs();
        if (!CAP_ON) return;
        once('cap-on', 'cap on');
        // Принудительный AAC имеет смысл только теперь (см. patchCodecs).
        patchCodecs();
      };
      cx.send(null);
    } catch (e) { pullInFlight = 0; }
  }
  pullConfig();

  // Временный безопасный зонд клавиатуры поиска: структура вокруг штатных
  // «ПРОБЕЛ»/«ОЧИСТИТЬ»/«ПОИСК» (и англ. варианты), чтобы встроить «ДАТА».
  // Не записывает текст поиска, значение input, HTML, URL, классы или атрибуты
  // с пользовательскими данными. После выяснения DOM зонд удалить.
  var kbdTries = 0, kbdDone = false, kbdLines = 0;
  function kbdLog(line) {
    if (kbdLines++ >= 14) return;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE + '/log', true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(MARK + ' kbd ' + line.slice(0, 170));
    } catch (e) { }
  }
  function kbdDescribe(el) {
    if (!el || el.nodeType !== 1) return '-';
    var r = el.getBoundingClientRect(), p = el.parentElement;
    var idx = p ? Array.prototype.indexOf.call(p.children, el) : -1;
    var role = el.getAttribute('role');
    return String(el.tagName).slice(0, 18) + '/role=' +
      (role === 'button' ? 'button' : (role ? 'other' : '-')) +
      '/tab=' + (el.hasAttribute('tabindex') ? el.tabIndex : '-') +
      '/child=' + el.children.length + '/idx=' + idx +
      '/xywh=' + [r.left, r.top, r.width, r.height].map(function (v) {
        return Math.round(v);
      }).join(',') + '/active=' + (document.activeElement === el ? 1 : 0);
  }
  function kbdPointProbe() {
    if (!document.elementFromPoint || !window.innerWidth || !window.innerHeight) return false;
    // Координаты только клавиш из присланного скриншота, не строки запроса.
    var points = [{ name: 'SPACE', x: 0.36 }, { name: 'CLEAR', x: 0.46 },
      { name: 'SEARCH', x: 0.57 }, { name: 'ARROW', x: 0.65 }];
    var lines = ['points viewport=' + window.innerWidth + 'x' + window.innerHeight];
    for (var i = 0; i < points.length; i++) {
      var el = document.elementFromPoint(Math.round(window.innerWidth * points[i].x),
        Math.round(window.innerHeight * 0.43));
      for (var depth = 0; el && depth < 3; depth++, el = el.parentElement)
        lines.push(points[i].name + '/' + depth + ' ' + kbdDescribe(el));
    }
    if (lines.length < 2) return false;
    for (var j = 0; j < lines.length; j++) kbdLog(lines[j]);
    return true;
  }
  function kbdInGuide(el) {
    try {
      for (var p = el, d = 0; p && d < 8; d++, p = p.parentElement) {
        var tn = String(p.tagName || '').toUpperCase();
        if (tn.indexOf('YTLR-GUIDE-ENTRY') >= 0) return true;
      }
    } catch (e) { }
    return false;
  }

  function kbdProbe() {
    if (kbdDone) return;
    if (++kbdTries > 120) { clearInterval(kbdTimer); return; }
    if (!document.body) return;
    var labels = { SEARCH: null, SPACE: null, CLEAR: null };
    var localized = { 'ПОИСК': 'SEARCH', 'ПРОБЕЛ': 'SPACE',
      'ОЧИСТИТЬ': 'CLEAR' };
    try {
      var walker = document.createTreeWalker(document.body, 4, null, false), n;
      while ((n = walker.nextNode())) {
        var text = String(n.nodeValue || '').replace(/^\s+|\s+$/g, '').toUpperCase();
        var key = localized[text] || text;
        if (Object.prototype.hasOwnProperty.call(labels, key) && !labels[key]) {
          var candidate = n.parentElement;
          if (!candidate) continue;
          if (kbdInGuide(candidate)) continue;
          var box = candidate.getBoundingClientRect();
          // Верхняя строка запроса тоже может буквально называться «ПОИСК».
          // Штатная клавиатура на скриншоте ниже верхней четверти экрана.
          if (!box.width || !box.height ||
              (key === 'SEARCH' && box.top < window.innerHeight * 0.24)) continue;
          labels[key] = candidate;
        }
      }
      if (labels.SEARCH && labels.SPACE && labels.CLEAR) {
        var b1 = labels.SEARCH.getBoundingClientRect();
        var b2 = labels.SPACE.getBoundingClientRect();
        var b3 = labels.CLEAR.getBoundingClientRect();
        if (b1.width && b1.height && b2.width && b2.height && b3.width && b3.height) {
          var tmax = Math.max(b1.top, b2.top, b3.top);
          var tmin = Math.min(b1.top, b2.top, b3.top);
          if (tmax - tmin <= Math.max(40, Math.min(b1.height, b2.height, b3.height) * 1.6)) {
            var lines = [];
            for (var name in labels) {
              var el = labels[name];
              if (!el) continue;
              for (var depth = 0; el && depth < 5; depth++, el = el.parentElement)
                lines.push(name + '/' + depth + ' ' + kbdDescribe(el));
            }
            kbdDone = true;
            clearInterval(kbdTimer);
            for (var i = 0; i < lines.length; i++) kbdLog(lines[i]);
            return;
          }
        }
      }
      // Отдельная надпись «ПОИСК» ещё не доказывает наличие клавиатуры.
      // Семплируем DOM по точкам только после поискового запроса, если ряд
      // из трёх подписей не найден; текст/HTML не читаем и не пишем.
      if (kbdTries >= 5 && searchTraces > 0 && kbdPointProbe()) {
        kbdDone = true;
        clearInterval(kbdTimer);
      }
    } catch (e) { if (kbdTries === 120) kbdLog('unavailable'); }
  }
  // Текстовый probe клавиатуры больше не запускаем: он устарел и читает
  // соседние text nodes. Диагностика сортировки не читает ввод пользователя.

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
  // Конфиг моста (флаг `aac`) перечитываем всё время: его включают уже после
  // старта, а хуки кодеков должны быть на месте ДО того, как плеер спросит
  // isTypeSupported для нового ролика.
  setInterval(pullConfig, 12000);
})();

;
