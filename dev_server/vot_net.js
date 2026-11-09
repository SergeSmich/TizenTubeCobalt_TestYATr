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
  // ---- Названия карточек ---------------------------------------------------
  // Из ответов search/browse вытаскиваем пары videoId→название и отдаём
  // оверлею (window.__votTitleBatch). Сами тела не логируем: в /log уходят
  // только счётчики. Названия нужны и для карточек сайдбара/главной.
  var ttHooks = 0;
  // Только ленты с роликами. Guide (меню/подписки) сюда не входит: оттуда в
  // кэш попадали названия каналов, и перевод затирал подписи меню.
  function ttIsList(u) {
    var s = String(u || '');
    return /(?:^|\/)youtubei\/v1\/(search|browse|next)(?:[?#]|$)/.test(s);
  }
  function ttText(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
    if (typeof v !== 'object') return '';
    if (typeof v.simpleText === 'string' && v.simpleText) return ttText(v.simpleText);
    if (typeof v.content === 'string' && v.content) return ttText(v.content);
    if (typeof v.text === 'string' && v.text) return ttText(v.text);
    if (v.runs && v.runs.length) {
      var s = '';
      for (var i = 0; i < v.runs.length; i++) {
        var r = v.runs[i];
        if (r && typeof r.text === 'string') s += r.text;
      }
      if (s) return ttText(s);
    }
    return '';
  }
  function ttTitleOf(o) {
    var t = ttText(o.title);
    if (t) return t;
    t = ttText(o.headline);
    if (t) return t;
    t = ttText(o.primaryText);
    if (t) return t;
    var md = o.metadata;
    if (md && md.lockupMetadataViewModel) {
      t = ttText(md.lockupMetadataViewModel.title);
      if (t) return t;
    }
    var ov = o.overlayMetadata;
    if (ov) {
      t = ttText(ov.primaryText);
      if (t) return t;
    }
    return '';
  }
  // Заголовок может лежать не в самом объекте с id, а на 1–3 уровня глубже
  // (TV: tileRenderer → header.tileHeaderRenderer.title).
  function ttDeepTitle(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return '';
    if (Object.prototype.toString.call(o) === '[object Array]') {
      for (var i = 0; i < o.length; i++) {
        var ra = ttDeepTitle(o[i], depth + 1);
        if (ra) return ra;
      }
      return '';
    }
    var t = ttTitleOf(o);
    if (t) return t;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (v && typeof v === 'object') {
        var r = ttDeepTitle(v, depth + 1);
        if (r) return r;
      }
    }
    return '';
  }
  function ttWalk(root) {
    var out = [], seen = {}, stack = [root], nodes = 0, i;
    while (stack.length && nodes < 20000 && out.length < 60) {
      var n = stack.pop();
      nodes++;
      if (!n || typeof n !== 'object') continue;
      if (Object.prototype.toString.call(n) === '[object Array]') {
        // stack.pop() берёт последний: pushed в обратном порядке, чтобы обход
        // шёл в порядке ответа (первая карточка экрана — первой в очереди).
        for (i = n.length - 1; i >= 0; i--) stack.push(n[i]);
        continue;
      }
      var id = n.videoId;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,}$/.test(id)) {
        id = typeof n.contentId === 'string' && /^[A-Za-z0-9_-]{6,}$/.test(n.contentId)
          ? n.contentId : '';
      }
      if (id && !seen[id]) {
        var t = ttTitleOf(n) || ttDeepTitle(n, 0);
        if (t && t.length <= 120) { seen[id] = 1; out.push({ id: id, t: t }); }
      }
      for (var k in n) {
        if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
        var v = n[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return out;
  }
  var ttDiagN = 0;
  function ttDiag(tag, len, n) {
    if (ttDiagN++ < 10) post('title_scan ' + tag + ' len=' + len + ' items=' + n);
  }
  function ttHand(list) {
    if (!list.length) return;
    var added = 0;
    if (window.__votTitleBatch) {
      try { added = window.__votTitleBatch(list) || 0; } catch (e) { }
    }
    if (ttHooks++ < 8) post('title_hook got=' + list.length + ' new=' + added
      + ' hook=' + (window.__votTitleBatch ? 1 : 0));
  }
  function ttScanText(text) {
    if (typeof text !== 'string' || !text || text.length > 4000000) return;
    if (text.charCodeAt(0) !== 123) return; // '{'
    var j;
    try { j = JSON.parse(text); } catch (e) { ttDiag('parsefail', text.length, 0); return; }
    var out = ttWalk(j);
    ttDiag('json', text.length, out.length);
    ttHand(out);
  }
  function ttScanObj(j) {
    if (!j || typeof j !== 'object') return;
    var out = ttWalk(j);
    ttDiag('obj', 0, out.length);
    ttHand(out);
  }
  function ttFromXhr(x) {
    try {
      var r = x.response;
      if (r && typeof r === 'object') { ttScanObj(r); return; }
    } catch (e) { }
    try { ttScanText(x.responseText); } catch (e) { }
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
      } else if (ttIsList(u)) {
        var tx = this;
        try { once('ttsrc|' + netKey(u), 'title_src xhr ' + netKey(u)); } catch (e) { }
        try { tx.addEventListener('loadend', function () { ttFromXhr(tx); }); } catch (e) { }
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
        } else if (ttIsList(u)) {
          try { once('ttsrc|' + netKey(u), 'title_src fetch ' + netKey(u)); } catch (e0) { }
          p.then(function (r) {
            try {
              r.clone().text().then(ttScanText, function () { });
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
