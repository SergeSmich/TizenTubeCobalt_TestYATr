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
