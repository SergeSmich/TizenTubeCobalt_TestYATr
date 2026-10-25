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
