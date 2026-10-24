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
  // How long we keep asking Yandex while the PC is downloading/uploading the
  // source audio. The PC needs 30-150 s (download + 10 chunks), and Yandex
  // answers 6 the whole time, so the normal "status 6 = dead end" logic must
  // not apply - it used to kill the translation 5 s after the fill started.
  var PC_FILL_WAIT = 600000;
  // How long we wait for the page player to actually land on 0:00 when we
  // rewind the video as the translation starts.
  var RESTART_MAX_WAIT = 4000;
  var MARK = 'VOT-OVERLAY-V14';

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
    faTried: false,
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
    pcTried: false,
    pcDeadline: 0,
    pcFailed: false,
    pcDone: false,
    pcWaits: 0
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
      el.textContent = MARK + ' — ожидание видео';
      (document.body || document.documentElement).appendChild(el);
      statusEl = el;
    } catch (e) { }
    return statusEl;
  }

  function setStatus(text, color) {
    try { state.uiStatus = String(text || ''); } catch (e0) { }
    try {
      var el = ensureStatus();
      if (!el) return;
      el.textContent = text;
      el.style.borderLeft = '4px solid ' + (color || '#90a4ae');
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
    return best || (vs.length ? vs[0] : null);
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

  // Cheap status-6 path: pretend the in-page audio probe failed and upload an
  // empty buffer, then re-ask Yandex to translate. No YouTube download at all.
  function failAudio(id, dur, tid) {
    if (state.faTried) { uploadAudio(id, dur, tid); return; }
    state.faTried = true;
    if (!tid) { uploadAudio(id, dur, tid); return; }
    state.translationId = tid;
    setStatus('Перевод: прошу сервер взять звук сам…', '#f5a623');
    log('failaudio id=' + id + ' tid=' + tid);
    http('POST', '/failaudio',
      { videoUrl: watchUrl(id), videoId: id, translationId: String(tid) },
      function (r) {
        log('failaudio ok ' + JSON.stringify(r));
        if (r && r.skipped) {
          // Config says "skip": keep polling and let Yandex decide.
          setStatus('Перевод: жду решения сервера…', '#f5a623');
          poll(id, dur, 60);
          return;
        }
        setStatus('Перевод: перевожу без загрузки звука…', '#f5a623');
        http('POST', '/translate',
          { videoUrl: watchUrl(id), duration: dur, firstRequest: true, lang: state.lang || 'en', targetLang: 'ru', title: state.title },
          function (r2) { state.busy = true; handleResp(r2, id, dur, 30); },
          function (e) { log('retry after failaudio ERR ' + e); state.busy = false; uploadAudio(id, dur, tid); });
      },
      function (e) {
        log('failaudio ERR ' + e);
        uploadAudio(id, dur, tid);
      });
  }

  // status 6 (AUDIO_REQUESTED): download the source audio via the bridge and
  // upload it to Yandex, then continue polling for the finished translation.
  function uploadAudio(id, dur, tid) {
    if (!tid) { state.busy = false; setStatus('Перевод: нет translationId для аудио', '#e53935'); return; }
    if (state.uploading) return;
    if (state.audioUploaded) { poll(id, dur, 30); return; }
    state.uploading = true;
    state.translationId = tid;
    setStatus('Перевод: ищу исходный звук…', '#f5a623');
    log('audio lookup id=' + id + ' tid=' + tid);
    innertubeAudio(id, function (a) {
      log('audio src itag=' + a.itag + ' url=' + String(a.url).slice(0, 60));
      setStatus('Перевод: скачиваю и загружаю звук…\nitag=' + a.itag, '#f5a623');
      http('POST', '/audio',
        { videoUrl: watchUrl(id), translationId: tid, audioUrl: a.url, itag: a.itag },
        function (r) {
          state.uploading = false;
          state.audioUploaded = true;
          log('audio upload ok size=' + r.size);
          setStatus('Перевод: звук загружен, жду перевод…', '#f5a623');
          poll(id, dur, 5);
        },
        function (e) { state.uploading = false; state.busy = false; setStatus('Перевод: не удалось загрузить звук\n' + e, '#e53935'); log('audio upload ERR ' + e); });
    }, function (e) {
      state.uploading = false;
      state.busy = false;
      setStatus('Перевод: не удалось получить звук\n' + e, '#e53935');
      log('audio inner ERR ' + e);
    });
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
    setStatus('Перевод: ПК готовит звук…\nобычно до минуты', '#f5a623');
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
      var alt = (state.lang === 'en') ? 'auto' : 'en';
      state.busy = false;
      log(why + ' -> other shard lang=' + alt);
      setStatus('Перевод: ищу в другом кэше…', '#f5a623');
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
      ' lively=' + (r.lively ? 1 : 0));
    if (r.translationId) state.translationId = r.translationId;
    if (r.lively) state.livelyVoice = true;
    if (r.status === 1 && r.audioUrl) { state.busy = false; onReady(r.audioUrl); return; }
    // status 5 = partial_ready: the audio URL already works, only the tail of
    // the video is still being translated. Start playing right away instead
    // of waiting for the full file (~20 s later).
    if (r.status === 5 && r.audioUrl) {
      state.busy = false;
      onPartial(r.audioUrl);
      poll(id, dur, r.remaining != null ? r.remaining : fallbackRem);
      return;
    }
    // While the PC filler runs, Yandex keeps answering 6 (audio requested) or 0
    // (nothing yet) until the bytes land. Waiting is the whole point here, so
    // never let those codes reach the failure branches below.
    if (state.pcTried && !state.pcDone && (r.status === 6 || r.status === 0)) {
      state.busy = false;
      if (state.pcFailed) return;
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
      setStatus('Перевод: ПК готовит звук…\nещё до ' + left + 'с', '#f5a623');
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
      // "Не удается перевести видео, попробуйте позже" is often transient: retry
      // the first request once before giving up. Yandex caches the verdict by
      // translationId and answers in ~0.1 s, so this retry costs almost nothing.
      if (!state.retried && /позже|later|try/i.test(msg)) {
        state.retried = true;
        log('retry after status=0 msg=' + msg);
        setStatus('Перевод: повторяю запрос…', '#f5a623');
        setTimeout(function () { if (state.curId === id) startTranslation(id, dur); }, 2000);
        return;
      }
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
      if (escalate(id, dur, r, 'status=6')) return;
      state.busy = false;
      // Both shards are empty. Handing Yandex the real audio is what the browser
      // extension does, but on this TV it cannot work: every innerTube client
      // either answers LOGIN_REQUIRED or returns googlevideo urls without a valid
      // poToken, and the player itself never sends one (it plays through MSE from
      // SABR, where the token lives inside the native stack). Kept behind
      // `audioMode:"on"` only, so the normal path stays instant.
      var tid6 = r.translationId || state.translationId;
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
    if (uiPref('translate.enabled', true) === false) {
      state.busy = false;
      log('translate skipped: disabled in prefs id=' + id);
      setStatus('Перевод выключен в настройках\nвключить: F4 → «Перевод включён»', '#90a4ae');
      return;
    }
    // Перевод нужен «с иностранного на русский», поэтому по умолчанию
    // исключён русский: ролик на русском переводить не надо.
    var skip = String(uiPref('skipLang', 'ru') || '').toLowerCase();
    var orig = String(state.origLang || '').toLowerCase();
    // Язык оригинала приходит с ПК асинхронно (yt-dlp, холодный кэш ~10 с).
    // Если решить сразу, русский ролик успеет уехать в перевод — ждём метаданные.
    if (skip && !orig) {
      var mt = metaTries || 0;
      // Ждём метаданные недолго: у закэшированных роликов язык приходит за ~0.1 с,
      // у холодных — несколько секунд. Долгое ожидание ломает быстрый старт
      // перевода, поэтому после ~4.5 с стартуем, а если язык позже окажется
      // исключённым — гасим перевод (maybeSkipNow).
      if (mt < 3) {
        // Первый тик короткий: у тёплого кэша язык приходит за ~0.1–0.4 с,
        // и ждать полтора секунды впустую незачем.
        var waitMs = (mt === 0) ? 600 : 1500;
        log('translate waiting for source lang try=' + (mt + 1) + ' id=' + id);
        setTimeout(function () {
          if (state.curId === id) startTranslation(id, dur, lang, mt + 1);
        }, waitMs);
        return;
      }
      log('translate: source lang unknown, starting anyway id=' + id);
    }
    if (skip && orig && skip === orig) {
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

  function poll(id, dur, remaining) {
    // Перевод отменён (язык исключён) — не тратим запросы и поллинг.
    if (state.skipLangBlock === id) { state.busy = false; return; }
    if (remaining <= 0) { state.busy = false; setStatus('Перевод: нет готового перевода', '#e53935'); return; }
    // The server hint ("rem=71") is very conservative: in practice the
    // translation shows up much sooner, so never sleep longer than POLL_MAX.
    var delay = Math.min(Math.max(POLL_BASE, remaining * 1000), POLL_MAX);
    setStatus((state.active ? 'Перевод: играю, доготовится…' : 'Перевод: в очереди/переводится…') +
      ' (~' + remaining + 'с)', '#f5a623');
    log('poll in ' + (delay / 1000).toFixed(0) + 's rem=' + remaining);
    setTimeout(function () {
      // За время ожидания перевод мог быть отменён (пришёл язык из skipLang).
      if (state.skipLangBlock === id || state.curId !== id) { state.busy = false; return; }
      http('POST', '/translate',
        { videoUrl: watchUrl(id), duration: dur, firstRequest: false, lang: state.lang || 'en', targetLang: 'ru' },
        function (r) { handleResp(r, id, dur, Math.max(3, remaining - 1)); },
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
      if (pageGone) { stopAudio(false); return; }
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
    state.faTried = false;
    state.pcTried = false;
    state.pcDeadline = 0;
    state.pcFailed = false;
    state.pcDone = false;
    state.pcWaits = 0;
    state.livelyVoice = false;
    state.playedOnce = false;
    state.restarting = false;
    state.lastSeek = 0;
    http('POST', '/stop', { }, function () { }, function () { });
    setStatus('Перевод: видео найдено, жду плеер…\nvideo=' + id, '#90a4ae');
    log('watch detected id=' + id);
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

  // Пока микс недоступен (одна аудиодорожка на поток), «оригинал» задаёт громкость,
  // когда играет оригинал, «перевод» — когда играет перевод.
  function applyVolume() {
    var v = findVideo();
    if (!v) return;
    var pct = Number(state.active ? uiPref('vol.translate', 100) : uiPref('vol.original', 100));
    if (isNaN(pct)) pct = 100;
    try { v.muted = (pct <= 0); } catch (e) { }
    try { v.volume = Math.max(0, Math.min(1, pct / 100)); } catch (e2) { }
    // Cobalt может игнорировать v.volume (звук идёт мимо WebAudio), поэтому
    // логируем и запрошенное, и фактическое значение — иначе не отличить
    // «ползунок не работает» от «громкость применяется на стороне плеера».
    var got = 1;
    try { got = v.volume; } catch (e3) { got = -1; }
    log('vol pct=' + pct + ' active=' + (state.active ? 1 : 0) + ' muted=' + (v.muted ? 1 : 0)
      + ' got=' + got);
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
    var skip = String(uiPref('skipLang', 'ru') || '').toLowerCase();
    if (!skip || String(lang || '').toLowerCase() !== skip) return;
    if (state.skipLangBlock === id) return;
    state.skipLangBlock = id;
    var wasRunning = state.active || state.audioPaused || state.busy;
    log((wasRunning ? 'translate abort: source lang=' : 'translate skip (late meta): source lang=')
      + lang + ' matches skipLang=' + skip + ' id=' + id);
    state.busy = false;
    if (wasRunning) stopAudio(true);
    setStatus('Перевод: ролик на языке «' + langLabel(lang) + '»\n(исключён в настройках)', '#90a4ae');
  }

  // Язык оригинала: на ТВ-сборке ytInitialPlayerResponse нет, поэтому язык
  // спрашиваем у ПК (yt-dlp metadata); нужен для пункта «не переводить с языка».
  // Прямой запрос к ПК (http://192.168.1.186) из HTTPS-страницы блокируется как
  // mixed content, поэтому идём через мост: /fill_status он уже проксирует на ПК,
  // а ПК дописывает в ответ lang/title (с кэшем и фоновой догрузкой yt-dlp).
  // Пока ПК не успел — повторяем опрос.
  function fetchMeta(id, tries) {
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
      if (n < 8) setTimeout(function () { fetchMeta(id, n + 1); }, 2500);
      else log('meta id=' + id + ' lang unknown (pc meta timeout)');
    }, function (e) {
      // Сетевая ошибка (ПК перезапускается) — это не «языка нет»: повторяем,
      // иначе ролик навсегда останется без определения языка.
      if (state.curId !== id) return;
      log('meta ERR ' + (e && e.message) + ' try=' + (n + 1));
      if (n < 8) setTimeout(function () { fetchMeta(id, n + 1); }, 2500);
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
      uiToast('ПК: ' + String((j && j.state) || '?') + ((j && j.status) ? ' · status=' + j.status : ''));
    }, function (e) { uiToast('ПК недоступен: ' + (e && e.message)); });
  }

  function openTranslatePanel() {
    if (!window.VOTUI || !VOTUI.open) { uiToast('UI-слой не загружен'); return; }
    var items = [
      { title: 'Перевод включён', type: 'toggle',
        value: function () { return uiPref('translate.enabled', true) !== false; },
        onSelect: function () { uiSet('translate.enabled', uiPref('translate.enabled', true) === false); } },
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
      { title: 'Уровень звука перевода', type: 'slider', min: 0, max: 100, step: 5,
        value: function () { return Number(uiPref('vol.translate', 100)); },
        format: function (v) { return v + '%'; },
        onChange: function (v) { uiSet('vol.translate', v); applyVolume(); } },
      { title: 'Уровень звука оригинала', type: 'slider', min: 0, max: 100, step: 5,
        value: function () { return Number(uiPref('vol.original', 100)); },
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
      title: 'Перевод (Яндекс)',
      subtitle: state.curId ? ('ролик ' + state.curId + (state.lang ? ' · шард ' + state.lang : '')) : 'ролик не открыт',
      items: items
    });
  }

  // Лог фокуса: что реально в фокусе после каждого нажатия (до 80 строк).
  // hit=1 означает, что в фокусе наша кнопка «Перевод» (сравнение делается в JS,
  // потому что кириллица в logcat ломается кодировкой консоли).
  var dbgKeys = 0;
  function debugKeys() {
    if (uiPref('debug.keys', true) === false) return;
    window.addEventListener('keydown', function (e) {
      if (dbgKeys >= 80) return;
      dbgKeys++;
      var a = document.activeElement, t = '', al = '', hit = 0;
      try {
        if (a.getAttribute) al = String(a.getAttribute('aria-label') || '');
        var raw = String((a && a.textContent) || '').replace(/\s+/g, ' ');
        t = raw.slice(0, 16);
        hit = (raw.indexOf('Перевод') >= 0 || al.indexOf('Перевод') >= 0) ? 1 : 0;
      } catch (x) { }
      log('K kc=' + e.keyCode + ' fa=' + (a ? String(a.tagName).toLowerCase().slice(0, 16) : '-')
        + ' hit=' + hit + ' t=' + t);
    }, true);
  }

  function setupUI() {
    if (!window.VOTUI || !VOTUI.on) return;
    VOTUI.init();
    debugKeys();
    // Однократная миграция префов. В тестах skipLang сохранился как «en»,
    // из-за чего основной сценарий (англоязычный ролик) молча пропускался.
    // Перевод нужен «с иностранного на русский», поэтому исключён русский.
    if (Number(uiPref('prefs.v', 1)) < 2) {
      uiSet('skipLang', 'ru');
      uiSet('prefs.v', 2);
      log('prefs migrated to v2: skipLang=ru');
    }
    VOTUI.on('menu.toggle', function () {
      if (VOTUI.isOpen()) VOTUI.close(); else openTranslatePanel();
    });
    VOTUI.on('translate.toggle', function () {
      var on = uiPref('translate.enabled', true) !== false;
      uiSet('translate.enabled', !on);
      uiToast(on ? 'Перевод выключен' : 'Перевод включён');
    });
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
  var VOT_ACTION = 'VOT_PANEL_SHOW';
  var btnLog = 0;

  function votBtnItem() {
    return {
      type: VOT_BTN_TYPE,
      button: {
        buttonRenderer: {
          isDisabled: false,
          text: { runs: [{ text: 'Перевод' }] },
          icon: { iconType: 'TRANSLATE' },
          command: { customAction: { action: VOT_ACTION } },
          trackingParams: null
        }
      }
    };
  }

  function injectVotBtn(res) {
    if (!res || typeof res.length !== 'number' || !res.length) return res;
    var types = [], have = false, at = -1, i;
    for (i = 0; i < res.length; i++) {
      var it = res[i];
      if (!it || typeof it !== 'object' || typeof it.type !== 'string') return res;
      types.push(String(it.type).replace('TRANSPORT_CONTROLS_BUTTON_TYPE_', ''));
      var bc = it.button && it.button.buttonRenderer && it.button.buttonRenderer.command;
      if (it.type === VOT_BTN_TYPE && actionOf(bc) === VOT_ACTION) have = true;
      if (at < 0 && it.type.indexOf('PLAYBACK_SETTINGS') >= 0) at = i;
    }
    if (have) return res;
    var btn = votBtnItem();
    if (at >= 0) res.splice(at, 0, btn); else res.push(btn);
    if (btnLog < 4) { btnLog++; log('btn injected [' + types.join('|') + '] ' + (at < 0 ? 'end' : 'at ' + at)); }
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

  // Пункт «Перевод» в нативном меню настроек плеера (шестерёнка). Это самый
  // надёжный путь: TizenTube сам так вставляет мини-плеер/шаринг/PiP, и они видны.
  function votPopupItem() {
    return {
      compactLinkRenderer: {
        title: { simpleText: 'Перевод' },
        icon: { iconType: 'TRANSLATE' },
        serviceEndpoint: {
          commandExecutorCommand: { commands: [{ customAction: { action: VOT_ACTION } }] }
        }
      }
    };
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

  function popupInsert(cmd) {
    if (!cmd || typeof cmd !== 'object' || !cmd.openPopupAction) return 0;
    var lists = collectItemLists(cmd, [], 0), done = 0;
    for (var i = 0; i < lists.length && !done; i++) {
      var arr = lists[i], looks = false, have = false, j;
      for (j = 0; j < arr.length; j++) {
        var it = arr[j];
        if (!it || !it.compactLinkRenderer) continue;
        looks = true;
        var ic = it.compactLinkRenderer.serviceEndpoint
          && it.compactLinkRenderer.serviceEndpoint.commandExecutorCommand
          && it.compactLinkRenderer.serviceEndpoint.commandExecutorCommand.commands;
        if (ic) for (var q = 0; q < ic.length; q++) if (actionOf(ic[q]) === VOT_ACTION) have = true;
      }
      if (!looks || have) continue;
      arr.splice(Math.min(1, arr.length), 0, votPopupItem());
      done = 1;
      log('popup item inserted n=' + arr.length);
    }
    return done;
  }

  function hookResolve(inst, where) {
    if (!inst || typeof inst.resolveCommand !== 'function') return 0;
    var rc = inst.resolveCommand;
    if (rc.__votHooked) return 0;
    var h = function (cmd) {
      try {
        var act = actionOf(cmd);
        if (act === VOT_ACTION) { log('btn PRESSED'); openTranslatePanel(); return true; }
        var cc = cmd && cmd.commandExecutorCommand && cmd.commandExecutorCommand.commands;
        if (cc && cc.length) {
          for (var i = 0; i < cc.length; i++) {
            if (actionOf(cc[i]) === VOT_ACTION) { log('btn PRESSED exec'); openTranslatePanel(); return true; }
          }
        }
      } catch (e) { }
      // Даём отработать TizenTube (она сдвигает индексы в списке), затем вставляем
      // свой пункт в уже готовый список настроек плеера.
      var r = rc.apply(this, arguments);
      if (cmd && cmd.openPopupAction) {
        try { popupInsert(cmd); } catch (e2) { log('popup ERR ' + (e2 && e2.message)); }
      }
      return r;
    };
    h.__votHooked = 1;
    inst.resolveCommand = h;
    log('resolve hooked via ' + where);
    return 1;
  }

  function hookAllInstances() {
    if (!window._yttv) return 0;
    var n = 0;
    for (var k in window._yttv) {
      var e = null;
      try { e = window._yttv[k]; } catch (x) { continue; }
      if (!e) continue;
      try { if (e.instance) n += hookResolve(e.instance, k + '.instance'); } catch (x2) { }
      try { if (e.prototype && e.prototype.resolveCommand) n += hookResolve(e.prototype, k + '.prototype'); } catch (x3) { }
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
  // ===== VOT-UI END =====

  setupUI();
  btnRetry();

})();
