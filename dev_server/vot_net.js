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

  function rememberSabr(u, headers, body, method, src) {
    var b = '';
    try {
      if (body && typeof body.byteLength === 'number') b = b64buf(body);
      else if (body && typeof body === 'string') b = b64buf(strBytes(body));
      else if (body && body.buffer && typeof body.byteLength === 'number') b = b64buf(body.buffer);
      else if (body && typeof body.arrayBuffer === 'function') {
        // Blob/File: читаем асинхронно и досылаем, когда байты будут.
        try {
          body.arrayBuffer().then(function (ab) {
            if (!ab || !ab.byteLength) return;
            SABR.body = b64buf(ab);
            SABR_BODY = '';
            sendSabr();
          });
        } catch (e) { }
      }
    } catch (e) { }
    var h = headersToObj(headers);
    // Content-Length браузер ставит сам, в наборе он не нужен.
    delete h['content-length'];
    SABR = { url: String(u || ''), headers: h, body: b,
             method: String(method || 'GET').toUpperCase(), ts: Date.now(),
             vid: capVideoId() };
    once('sabrcap' + (src || ''), 'sabr-req[' + (src || '?') + '] m=' + SABR.method
      + ' len=' + SABR.url.length + ' body=' + b.length
      + ' bdesc=' + bodyDesc(body) + ' hdr=' + Object.keys(h).join('|'));
    sendSabr();
  }

  // Отдать запрос мосту. Плеер постит SABR часто, поэтому не чаще раза в 3 с и
  // только если тело изменилось (rn в URL меняется, тело — нет).
  var SABR_TS = 0, SABR_BODY = '';

  function sendSabr() {
    if (!SABR) return;
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

  function rememberPlayerJson(j) {
    try {
      var sd = (j && j.streamingData) || null;
      if (!sd || !sd.serverAbrStreamingUrl) return;
      var mc = ((j.playerConfig || {}).mediaCommonConfig) || {};
      var ur = mc.mediaUstreamerRequestConfig || {};
      var ucfg = String(ur.videoPlaybackUstreamerConfig || '');
      var fmts = sd.adaptiveFormats || [];
      // Диагностика выбора дорожки: TV-плеер уходит в автодуб
      // (`acont=dubbed-auto:lang=xx`), и мы получаем медиа дубля, а не
      // оригинала. Список аудиоформатов с xtags/audioTrack показывает, есть ли
      // в ответе оригинальная дорожка и как она называется.
      try {
        var vdId = capVideoId() || '?';
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
        vid: capVideoId()
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
      var keep = null;
      if (sabr) {
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
      try {
        if (sabr) {
          try {
            var init = arguments.length > 1 ? arguments[1] : null;
            var mn = (init && init.method) || (input && input.method) || 'GET';
            rememberSabr(u, init && init.headers, init && init.body, mn, 'fetch');
            if (keep) {
              try {
                keep.arrayBuffer().then(function (ab) {
                  if (!ab || !ab.byteLength) return;
                  SABR.body = b64buf(ab);
                  SABR_BODY = '';
                  post('sabr-body len=' + ab.byteLength);
                  sendSabr();
                }, function (e) { post('sabr-body err=' + e); });
              } catch (e) { }
            }
            if ((!init || !init.body) && input && typeof input.clone === 'function') {
              try {
                input.clone().arrayBuffer().then(function (ab) {
                  if (!ab || !ab.byteLength) return;
                  SABR.body = b64buf(ab);
                  SABR_BODY = '';
                  sendSabr();
                });
              } catch (e) { }
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
                once('fplayer', 'fetch player len=' + t.length + ' status=' + (ps.status || '?') + ' ' + countFmts(j));
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
