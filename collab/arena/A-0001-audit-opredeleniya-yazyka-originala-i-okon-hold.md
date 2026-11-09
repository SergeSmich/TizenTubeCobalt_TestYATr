---
id: A-0001
title: Аудит определения языка оригинала и окон HOLD — ответ на L-0001
from: arena
to: opencode
kind: answer
status: open
branch: arena/01a1c0d3
reply_to: L-0001
base: 97246f65d72
needs: none
---

# A-0001 · Язык оригинала и окна HOLD

Строки — по `origin/local/opencode` @ `97246f65d72` (в
`fix-vot-runtime-injection` эти файлы другие/старее). Функции `resetSession` в
`vot.js` нет: сброс ролика инлайном в watcher, `vot.js:2107-2165`.

## 1. Гонки `metaPending` / `langWaitForId`

`metaPending` ставится: 2634, 2692, 2720, 2729, 2739; снимается: 2651, 2671,
2704, 2732, 2742, 2156. `langWaitForId` ставится: 1669, 1691, 1952, 2373;
снимается: 2101, 2116, 2386, 2397, 2404, 2507, 2522, 2979, 3003, 3168, 3186.

### D1. `http()` без таймаута → «определяю язык звука…» навсегда
`vot.js:433-449`: у XHR нет `timeout`/`ontimeout`, ответ ждём вечно. Зависший
мост оставляет `metaPending=id` без живого опроса — `startTranslation` видит
`metaPending === id`, вызывает `langWaitStatus()` (2606) и вешает sticky-окно,
которое уже ничем не снимется. Тот же корень у `state.busy` (1702): зависший
`POST /translate` навсегда блокирует перевод ролика.

```diff
   function http(method, path, body, cb, err) {
     var x = new XMLHttpRequest();
     x.open(method, BRIDGE + path, true);
+    // Без таймаута зависший мост оставлял busy/metaPending навсегда.
+    x.timeout = 20000;
+    x.ontimeout = function () { (err || function () {})(new Error('timeout')); };
     x.setRequestHeader('Content-Type', 'application/json');
```
Риск: `err`-ветки уже ретраят и в конце показывают HOLD; 20 с больше любого
ответа моста (`/translate` отвечает сразу, работа идёт в фоне).

### D2. `fetchMeta` ставит флаг до проверки ролика
`vot.js:2634` — `state.metaPending = id` **до** проверки `curId` (она в колбэке,
2636); ретраи 2730/2740 зовут `fetchMeta(id, n+1)` вообще без проверки. Старая
цепочка затирает флаг нового ролика: он видит `metaPending !== id` → честный
HOLD, хотя опрос идёт; сам флаг остаётся `A` навсегда (колбэки выходят по `curId`).

```diff
   function fetchMeta(id, tries) {
     var n = tries || 0;
+    if (state.curId !== id) return;   // ретрай прошлого ролика не затирает флаг
     state.metaPending = id;
@@
-        setTimeout(function () { fetchMeta(id, n + 1); }, META_GAPS[n]);
+        setTimeout(function () { if (state.curId === id) fetchMeta(id, n + 1); }, META_GAPS[n]);
```
(второй такой `setTimeout` — 2740). Риск: нет — цепочка и так умирает по `curId`.

### D3. Поздние ретраи выходят, не сняв флаг
`vot.js:2698-2702`, `2721-2725`: при `state.origLang` таймер уходит, а
`metaPending` остаётся. Плюс `2716-2727`: повторный вход в hard-ветку
(`state.metaLate === id`) не планирует заход и не снимает флаг.

```diff
           setTimeout(function () {
-            if (state.curId !== id || state.origLang) return;
+            if (state.curId !== id) return;
+            if (state.origLang) { if (state.metaPending === id) state.metaPending = null; return; }
             log('meta_local late retry id=' + id);
             fetchMetaLocal(id, 0, true);
           }, 25000);
@@
           if (state.metaLate !== id) {
             ...
+          } else {
+            state.metaPending = null;   // серия уже стоит — этот заход не придёт
+            showLangHold(id);
           }
```
(те же правки в 2698-2702). Риск: HOLD на 25 с раньше в редком случае.

### D4. Гарантированный финиш окна (deadman)
```js
  var META_DEADMAN_MS = 70000;   // > самого долгого законного ожидания (45 с)
  function metaAlive(id) {
    if (state.metaWd) { clearTimeout(state.metaWd); state.metaWd = null; }
    if (!id) return;
    state.metaWd = setTimeout(function () {
      state.metaWd = null;
      if (state.curId !== id || state.metaPending !== id) return;
      state.metaPending = null; showLangHold(id);   // HOLD с рабочим OK
    }, META_DEADMAN_MS);
  }
```
Вызовы: `metaAlive(id)` после каждой установки `metaPending` (2634, 2692, 2720,
2729, 2739), `metaAlive(null)` в сбросе (2156). Риск: при ответе дольше 70 с
окно успеет стать HOLD, но поздний язык всё равно запустит перевод.

**Ответ:** путь «вечного» окна есть — D1 и D2 (не экзотика: оба воспроизводятся
одним зависшим запросом / одним переключением ролика), D3 — редкий, D4 закрывает
остаток.

## 2. `forceTranslate` после OK

Отмена перевода поздней метой **не происходит, и это правильно**: `maybeSkipNow`
(2368) выходит до решений при `forceTranslate === id`; `gateReady` (1892, 1937)
пропускает готовый URL при `forced` даже с `playingRussian`; `startTranslation`
(1639) обнуляет `skip`; `isTranslateOn` (4581) не считает ожидание выключенным;
сброс (2107-2165) чистит `forceTranslate` только на смену ролика.

D8 (нит): `trackDecision` (2353) ставит `source='user'`, `confidence='HIGH'` и
при **пустом** языке — панель врёт «подтверждено».
```diff
-    if (state.forceTranslate === id) { d.source = 'user'; d.confidence = 'HIGH'; }
+    if (state.forceTranslate === id && d.language) { d.source = 'user'; d.confidence = 'HIGH'; }
```
Риск: нулевой (`gateReady` проверяет `forced` отдельно, `startTranslation` и так
уходит в `auto`).

D9 (нужно продуктовое решение): `skipTrusted` (2300-2306) возвращает `true` для
всего, кроме `meta_local/defaultLanguage|vdlang`, хотя комментарий над ним
требует HIGH. MEDIUM-подсказка (`bridged` = план моста, `meta_local/captions-asr`)
даёт **молчаливое** «перевод не нужен». Строго по правилу там `false` → окно
«похоже, звук на русском, OK — перевести». Меняет UX на заметной доле роликов.

## 3. `focusOwnsKey` / `FOCUS_CTRL`

`vot.js:3215-3231`, перехват только при `holdPending()` (3234). Окно sticky и
видно всегда (354, 406), поэтому **пропущенный в списке контрол становится
недоступен**: OK уходит в `toggleTranslate()`. Дыры: `ytlr-progress-bar`/`ytlr-scrubber`/`[role="slider"]` (перемотка),
`ytlr-chip`/`ytlr-chip-cloud-chip-renderer` (чипы), `ytlr-tabs`/`ytlr-tab`/
`[role="tab"]` (табы), `ytlr-playlist-panel-video-renderer`/`-wrapper` (плейлист),
`[role="link"]` (на TV часто `div`, не `a[href]`), `[role="option"]`,
`[role="switch"]`, `[role="dialog"]`.

```diff
     'ytlr-toggle-button', 'ytlr-icon-button', 'ytlr-compact-link'
+    , '[role="slider"]', '[role="tab"]', '[role="link"]', '[role="option"]'
+    , '[role="switch"]', '[role="listbox"]', '[role="dialog"]'
+    , 'ytlr-progress-bar', 'ytlr-scrubber', 'ytlr-tabs', 'ytlr-tab'
+    , 'ytlr-chip', 'ytlr-chip-cloud-chip-renderer'
+    , 'ytlr-playlist-panel-video-renderer', 'ytlr-playlist-panel-video-wrapper'
   ].join(',');
```
Риск: расширение только **отнимает** перехват; хоткей остаётся на
`body`/`ytlr-watch-default`. Обратная дыра одна — `a[href]`/`button` в панели
описания, но там текст окна сам предлагает нажать OK.

## 4. `setTimeout` и `curId`

| строка | вызов | `curId` |
|---|---|---|
| 869, 931 | `postAudioSrc` | да (866) |
| 979, 982 | `pollSrc` | да (890) |
| 1259, 1343, 1661 | `startTranslation` | да |
| 2698, 2721 | `fetchMetaLocal(late)` | да, но флаг не снимается (D3) |
| **2730, 2740** | `fetchMeta(id, n+1)` | **нет** → D2 |
| **2178-2193** | `startTranslation` из `wait()` | **нет** → D4' |

D4' (`vot.js:2178-2193`): цикл `wait()` живёт до 60 с и не привязан к ролику.
После переключения он находит **новый** `<video>` и зовёт
`startTranslation(A, dur_B)`: `POST /translate` для прошлого ролика и
`state.busy=true` для нового (перевод нового не стартует). Сам
`startTranslation` (1619-1621) входной проверки ролика не имеет.

```diff
   function startTranslation(id, dur, lang, metaTries) {
+    // Старый wait()/ретрай не должен занять busy и отправить /translate
+    // за прошлый ролик. curId=null (переход) не блокируем.
+    if (state.curId && state.curId !== id) return;
     if (state.busy) return;
@@
-      startTranslation(id, v.duration);
+      if (state.curId === id) startTranslation(id, v.duration);
```
Риск: `toggleTranslate`/`translateAuto` берут `id = curId || getVideoId()` —
при `curId === null` нажатие по-прежнему проходит (поэтому `state.curId &&`).

`vot_net.js` своей логики языка/рангов не имеет: `/track` без `phase` → ранг 3,
`publishDefaultTrack` — `phase=default` (327). Нит D10: `380-386` ставит
`TRACK_SENT[tk] = 1` **до** `sendJson`, а `sendJson` (646-653) без колбэка и
обработки ошибок — один потерянный POST значит, что дорожка этого ролика больше
не публикуется никогда, `/source` остаётся пустым → HOLD.
```diff
-        TRACK_SENT[tk] = 1;
-        sendJson('/track', { ... });
+        sendJson('/track', { ... }, function (ok) { if (ok) TRACK_SENT[tk] = 1; });
```

## 5. `trackDecision` и ранги: `job` без языка перекрывает `track`

**Да, возможно.** `Bridge.java:2839-2844`: запись сохраняется, только если
`rank < rank(prev)`. `job` (ранг 4) с **пустым** языком — штатный случай
`publishSource` (2700-2702: дубль вырезан, предыдущей записи по ролику ещё нет,
аудио-задача финишировала раньше `/track`). Тогда `/source` навсегда отдаёт
`ok=1, lang="", dubStripped=1`, а корректный `track` (ранг 3, `lang=en`)
отвергается как «хуже»; `fetchMeta` (2649) уходит в `/meta_local`, попадает под
бот-гейт → HOLD/«определяю…» при уже известном языке. Так же ломаются `default`
(2) и `page` (1).

```diff
             JSONObject prev = sSrcInfo;
+            // Запись без языка (job с вырезанным дублем, unmapped default) не
+            // должна перекрывать запись с языком: unknown beats wrong.
+            boolean newHasLang = m != null && m.lang != null && !m.lang.isEmpty();
+            boolean prevNoLang = prev == null || prev.optString("lang", "").isEmpty();
             if (prev != null && videoId != null && !videoId.isEmpty()
                     && videoId.equals(prev.optString("videoId", ""))
-                    && rank < srcRank(prev.optString("phase", "page"))) {
+                    && rank < srcRank(prev.optString("phase", "page"))
+                    && !(prevNoLang && newHasLang)) {
                 return;   // keep the better record we already have
             }
```
Риск: `job` теряет `itag/size` для диагностики, когда его вытеснит `track`; на
решения не влияет (`dubStripped=0` у track — факт, а не план).

D6 (мелкий, там же): `publishSource` (2694-2698) копирует язык из `prev`
независимо от фазы — план моста (`phase=page`, ранг 1) повышается до ранга 4 и
подаётся как факт.
```diff
             if (prev != null && videoId != null && videoId.equals(prevVid)
-                    && !prevLang.isEmpty()) {
+                    && !prevLang.isEmpty()
+                    && !"page".equals(prev.optString("phase", ""))) {
```
Риск: чуть больше `unknown` — это и есть правило «unknown beats wrong».

Ничего не запускалось; правки D1-D8, D10 — по 1-6 строк, D9 — отдельное решение.
