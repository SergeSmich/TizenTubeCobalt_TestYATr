---
id: A-0003
title: Google без ключа (диагностика отказов) и ревью подстановки названий в DOM
from: arena
to: opencode
kind: answer
status: open
branch: arena/01a1c0d3
reply_to: L-0003
base: 26ecd8fcc08
needs: none
---

# A-0003 · Google-эндпоинт и подстановка в DOM

Строки — по `origin/local/opencode` @ `26ecd8fcc08`. Патчи из A5/B10 проверены
`git apply` на этом дереве; сам репозиторий не менялся (ни `dev_server/**`, ни
`vot_bridge/**`), сборок и запусков не было.

---

# A. Google-эндпоинт без ключа

## A1. Почему элемент попадает в `fail` и как это отличить

Сейчас в `ttGoogle` (`Bridge.java:531-574`) любая проблема превращается в
`IOException("http N")`/`IOException("bad json")`, а вызывающий ловит `Throwable`
и пишет только `title_tr google item: <exception>` — без `id`, длины и времени.
Поэтому в логе видно «5 упало», но не видно, почему. Причины и их признаки:

| Причина | Признак в ответе | Ретрай |
|---|---|---|
| Лимит частоты | HTTP **429** (`http429`) | да, 1 раз через 600 мс; повторный 429 → пауза провайдера 60 с |
| Сервер | HTTP **5xx** (`http500`/`http503`) | да, 1 раз |
| Таймаут чтения 4 с | `SocketTimeoutException` → `timeout` | да, 1 раз |
| Нет сети / DNS | `ConnectException`/`UnknownHostException` → `net` | да; если и второй раз — вся пачка бессмысленна |
| Капча/согласие | HTTP 200, тело начинается с `<` → `html` | **нет** (это блок по IP/UA, повтор усугубляет) |
| Не JSON | `org.json` бросил → `json` | нет |
| Пустой ответ | массив есть, сегментов нет → `empty` | нет |
| Перевод == исходник | `ttValid` отбраковал (равно/без регистра) | **нет** — это `noop`, а не ошибка (см. D9) |
| Ответ раздут/многострочный | `ttValid`: `>160`, `\n`, префикс «перевод», `> len*2+20` | нет (`invalid`) |
| Мусор на входе | пусто или `> TT_MAX_CHARS` (`bad`) | нет |
| Не уложились в бюджет | `budget` | да, следующим тиком |
| Мост на паузе после 429 | `cool` | да, после кулдауна |

**Диагноз по вашим замерам.** 12 названий = **12 последовательных GET без пауз**
(`Bridge.java:649-656`). Бесплатный `translate_a/single` (лимит нигде не
документирован; по публичным сообщениям это короткая серия порядка 5-8 запросов
в окне, дальше 429) — отсюда ровно `ok=7 fail=5`.
Второй прогон даёт `ok=4 fail=8`, потому что: (1) 429 не запоминается и не
включает паузу — те же 5 названий идут в провайдер снова; (2) они не попали в
кэш, а 429-окно к этому моменту ещё не закрылось. То есть **это не «плохой
перевод», это rate limit плюс отсутствие negative-кэша.**

Второй класс отказов, который сейчас тоже считается `fail`, — `noop` (бренд,
латиница, уже русский): `ttValid` возвращает false, элемент уходит в `fail`,
в кэш не попадает и переспрашивается на **каждом** новом экране. На типичной
ленте это 20-40 % названий; они и создают постоянный фоновый трафик, который
добивает квоту.

## A2. Формат per-item лог-строки

```
title_tr item n=3/12 h=1a2b3c4d len=42 why=ok ms=187
title_tr item n=7/12 h=9f8e0c21 len=31 why=http429 ms=140
title_tr n=12 ok=10 fail=2 noop=3 skip=0 cache=412 ms=4310 cool
```

Правила: ≤120 символов; `h` — первые 8 hex `sha1("1:ru:"+src)` (сам заголовок в
лог не пишем: приватность и длина); `why=ok` пишем только для первых 8 элементов
пачки (видно, что она идёт), любой `why!=ok` — всегда; итог — одна строка на
пачку, с `noop`, `skip`, размером кэша и флагом `cool`.

## A3. Алгоритм: числа и обоснование

**Про бюджет 2.5 с.** 12 названий — это 12 отдельных GET: 12 × (200-350 мс сети)
= 2.4-4.2 с **только на сеть**, без паузы. В 2.5 с они не влезают физически.
Но 2.5 с и не нужны: подстановка идёт асинхронно в DOM (`ttApply`), сетка уже
нарисована с оригиналами, `ttPump` её не блокирует. Бюджет нужен лишь чтобы не
копить очередь «на потом» — поэтому **6 с** (худший случай холодного кэша),
а не 2.5.

- **Размер пачки:** 12 (не 20) — это ровно один экран поиска; 20 при паузе 160 мс
  не влезают в бюджет.
- **Пауза между GET:** 160 мс (≈6 запросов/с) — ниже порога, на котором
  начинаются 429; меньше 100 мс смысла нет.
- **Ретраи:** 1 повтор через 600 мс, только для `429/408/5xx/timeout/net`.
  `html/json/empty` не повторяем — ответ не изменится.
- **429 на пачке:** обрываем остаток, ставим `sTtCoolUntil = now + 60 с`, ответ —
  `ok=1` с уже готовыми и `fail.why=cool` на остальных. JS на `rate|cool`
  отступает на 30 с.
- **Single-flight:** `synchronized (TT_LOCK)` на весь `handleTitleTr` — иначе два
  запроса сетки (две страницы, повторный `ttPump`) снова складываются в серию.
- **Порядок «сначала видимые»:** мост сохраняет порядок запроса (`LinkedHashMap`),
  а в `vot_net.js` обход шёл через `stack.pop()`, то есть **в обратном** порядке
  ответа — первые карточки экрана попадали в конец очереди. Фикс — push в
  обратном порядке (в B10).
- **Negative-кэш:** `noop` пишется в тот же `title_tr_cache.json` на 30 дней
  (`{"noop":1}`), в ответе — `skip.why=noop`, JS запоминает на сессию.
- **Экономия записи:** `titleCacheSave` пишет весь файл (до ~1 МБ) на каждую
  пачку — при скролле это заметно на eMMC. Не чаще раза в 8 с.

**Ожидаемо после патча:** холодный кэш, 12 названий → 1 запрос к мосту,
`ok≈10-12`, `ms≈3.5-4.5 с`, в логе 12 строк с причинами. Повторный вход в ту же
сетку — `s=cache`, `ms≈30-60`. Бренды уходят в `noop`, `fail` остаётся близко к
нулю, 429 не появляется вовсе (6 запросов/с против серии без пауз).

## A4. Есть ли батч без ключа

**Официально — нет.** `translate.googleapis.com/translate_a/single` (и
`translate_a/t` со старым `client=t`) принимает **один** `q`; параметра «массив
текстов» у него нет, лимит — ~5 000 символов на запрос, лимит частоты не
документирован и меняется. `dt=t` управляет только форматом сегментов, не
количеством входов.

Что реально пробуют вместо батча и почему это не решение:

- **Склейка через `\n` в один `q`.** Google режет вход по предложениям, а не по
  строкам, поэтому `N` входных строк дают `M != N` сегментов; склеивать обратно
  приходится по `[i][1]` (оригинал сегмента) и сверять нормализованную склейку с
  входом. Это недокументированное поведение: на заголовках с «|», «—», «.» и
  эмодзи разметка расползается. Допустимо только как **эксперимент за флагом**:
  отправили — если число сегментов совпало и `orig`-склейка равна входу, берём;
  иначе откат на per-item. В основную ветку не ставлю из-за непроверяемости
  (запускать нельзя).
- **`translate_a/t`.** Тот же один `q`, тот же лимит частоты; выигрыша нет.
- **`dj=1`.** Не батч, а другой формат ответа (`{"sentences":[{"trans","orig"}]}`)
  — удобнее для сверки `orig`, если всё же делать склейку.
- **Cloud Translation v3 (с ключом)** — настоящий батч (до 128 сегментов/1024
  элементов на запрос), $20/1M символов. Это единственный вариант, где «12
  названий = 1 запрос» гарантировано, но он платный и требует платёжки (из РФ —
  с оговорками).

**Вывод:** без ключа батча нет; 10 из 12 даёт кэш + `noop` + пауза, а не склейка.

## A5. Патч `vot_bridge/java/vot/Bridge.java`

Применять из корня репозитория: `git apply -p1`. Меняет `ttGoogle` (+`ttParseGoogle`,
`ttRetryable`, `ttSame`), добавляет бюджет/паузу/ретраи/кулдаун/single-flight,
`noop` в кэш, throttled-запись кэша и per-item лог.

```diff
--- a/vot_bridge/java/vot/Bridge.java
+++ b/vot_bridge/java/vot/Bridge.java
@@ -274,6 +274,20 @@
     private static final int TT_MAX_CHARS = 120;
     private static final long TT_TTL_MS = 30L * 24 * 3600 * 1000;
     private static final int TT_CACHE_MAX = 5000;
+    // Бюджет ответа: сетку нельзя держать дольше, чем она рисуется. Всё, что не
+    // успело, уходит в fail:budget и переводится следующим тиком.
+    private static final long TT_BUDGET_MS = 6000;
+    // Пауза между GET и один повтор на 429/сеть: без них 12 запросов подряд
+    // получают 429, и половина пачки уходит в fail без причины в логе.
+    private static final int TT_GAP_MS = 160;
+    private static final int TT_RETRY_MS = 600;
+    private static final int TT_RETRIES = 1;
+    private static final long TT_COOL_MS = 60000;
+    private static final String TT_UA = "Mozilla/5.0 (Linux; Android 9; TV) "
+            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
+    private static final Object TT_LOCK = new Object();
+    private static volatile long sTtCoolUntil;
+    private static volatile long sTtCacheAt;
     private static final String TT_SYS =
             "Ты переводишь названия видео YouTube на русский. Верни СТРОГО JSON "
             + "{\"tr\":[{\"i\":<номер>,\"t\":\"<перевод>\"}]} без markdown и пояснений. "
@@ -362,6 +376,15 @@
         return o;
     }
 
+    // Кэш до 5000 записей — это ~1 МБ JSON; писать его на каждую пачку во время
+    // скролла нельзя (eMMC ТВ), поэтому не чаще раза в 8 с.
+    private static void titleCacheSaveThrottled(JSONObject c) {
+        long now = System.currentTimeMillis();
+        if (now - sTtCacheAt < 8000) return;
+        sTtCacheAt = now;
+        titleCacheSave(c);
+    }
+
     // Prune expired entries; when still too big, drop the least recently used.
     private static synchronized void titleCacheSave(JSONObject c) {
         try {
@@ -528,51 +551,84 @@
 
     // Google Translate web endpoint (provider=google): no key, one title per GET.
     // The bridge cache (30 days) keeps repeated grids free of requests.
+    // Причина отказа едет в тексте IOException (http429|http503|timeout|net|html|
+    // json|empty), чтобы вызывающий мог её залогировать и решить, повторять ли:
+    // повтор html/капчи или пустого ответа только добьёт квоту.
     private static String ttGoogle(String text, String lang) throws IOException {
-        String q = java.net.URLEncoder.encode(text, "UTF-8");
         String url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl="
-                + java.net.URLEncoder.encode(lang, "UTF-8") + "&dt=t&q=" + q;
+                + java.net.URLEncoder.encode(lang, "UTF-8") + "&dt=t&q="
+                + java.net.URLEncoder.encode(text, "UTF-8");
         HttpURLConnection c = null;
         try {
             c = (HttpURLConnection) new URL(url).openConnection();
             c.setConnectTimeout(4000);
-            c.setReadTimeout(9000);
-            c.setRequestProperty("User-Agent",
-                    "Mozilla/5.0 (Linux; Android 9; TV) AppleWebKit/537.36 "
-                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
+            c.setReadTimeout(4000);
+            c.setRequestProperty("User-Agent", TT_UA);
             int code = c.getResponseCode();
             InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
-            String text2 = "";
+            String body = "";
             if (in != null) {
                 ByteArrayOutputStream bo = new ByteArrayOutputStream();
                 byte[] buf = new byte[4096];
                 int n;
                 while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                 in.close();
-                text2 = new String(bo.toByteArray(), StandardCharsets.UTF_8);
+                body = new String(bo.toByteArray(), StandardCharsets.UTF_8);
             }
-            if (code < 200 || code >= 300) throw new IOException("http " + code);
-            // [[["перевод","оригинал",null,null,10],[" ..."],...],null,"en",...]
-            JSONArray outer;
-            try {
-                outer = new JSONArray(text2);
-            } catch (Throwable e) {
-                throw new IOException("bad json");
-            }
-            JSONArray segs = outer.optJSONArray(0);
-            StringBuilder sb = new StringBuilder();
-            if (segs != null) {
-                for (int i = 0; i < segs.length(); i++) {
-                    JSONArray s = segs.optJSONArray(i);
-                    if (s != null && s.length() > 0) sb.append(s.optString(0, ""));
-                }
-            }
-            return sb.toString();
+            if (code < 200 || code >= 300) throw new IOException("http" + code);
+            String one = ttParseGoogle(body);
+            if (one.trim().isEmpty()) throw new IOException("empty");
+            return one;
+        } catch (java.net.SocketTimeoutException e) {
+            throw new IOException("timeout");
+        } catch (java.net.UnknownHostException e) {
+            throw new IOException("net");
+        } catch (java.net.ConnectException e) {
+            throw new IOException("net");
         } finally {
             try { if (c != null) c.disconnect(); } catch (Throwable e) { }
         }
     }
 
+    // [[["перевод","оригинал",null,null,10],[" ..."],...],null,"en",...]
+    // HTML вместо JSON — это страница согласия/капчи: отдельная причина, не "json".
+    private static String ttParseGoogle(String body) throws IOException {
+        String s = body == null ? "" : body.trim();
+        if (s.isEmpty()) throw new IOException("empty");
+        if (s.charAt(0) == '<') throw new IOException("html");
+        JSONArray outer;
+        try {
+            outer = new JSONArray(s);
+        } catch (Throwable e) {
+            throw new IOException("json");
+        }
+        JSONArray segs = outer.optJSONArray(0);
+        StringBuilder sb = new StringBuilder();
+        if (segs != null) {
+            for (int i = 0; i < segs.length(); i++) {
+                JSONArray seg = segs.optJSONArray(i);
+                if (seg != null && seg.length() > 0) sb.append(seg.optString(0, ""));
+            }
+        }
+        return sb.toString();
+    }
+
+    // 429/408/5xx, таймаут и сеть — повторяем. html/json/empty — нет.
+    private static boolean ttRetryable(String why) {
+        if (why == null) return false;
+        if (why.equals("timeout") || why.equals("net")) return true;
+        if (!why.startsWith("http")) return false;
+        String n = why.substring(4);
+        return n.equals("429") || n.equals("408") || n.startsWith("5");
+    }
+
+    // Нечего переводить: бренд, латиница, уже русский текст. Это НЕ ошибка —
+    // такую пару надо запомнить, иначе каждый новый экран просит её заново.
+    private static boolean ttSame(String src, String tr) {
+        String b = ttNorm(tr);
+        return b.isEmpty() || ttNorm(src).equalsIgnoreCase(b);
+    }
+
     // Keep only sane translations: one line, bounded length, not the original,
     // no "перевод:" prefix. Everything else is a fail (original stays visible).
     private static boolean ttValid(String src, String tr) {
@@ -586,7 +642,16 @@
         return true;
     }
 
+    // Один провайдер на процесс: параллельные запросы сетки (две страницы, два
+    // батча) складываются в серию и получают 429. Второй вызов ждёт, после чего
+    // первый уже положил ответы в кэш и второй отвечает из него.
     private static String handleTitleTr(JSONObject req) {
+        synchronized (TT_LOCK) {
+            return handleTitleTrLocked(req);
+        }
+    }
+
+    private static String handleTitleTrLocked(JSONObject req) {
         long t0 = System.currentTimeMillis();
         JSONObject out = new JSONObject();
         JSONArray trs = new JSONArray(), skips = new JSONArray(), fails = new JSONArray();
@@ -618,6 +683,11 @@
                     String key = sha1hex("1:" + lang + ":" + src);
                     JSONObject e = cache.optJSONObject(key);
                     if (e != null && System.currentTimeMillis() - e.optLong("at", 0) <= TT_TTL_MS) {
+                        if (e.optInt("noop", 0) == 1) {
+                            skips.put(new JSONObject().put("id", id).put("why", "noop")
+                                    .put("src", src));
+                            continue;
+                        }
                         trs.put(new JSONObject().put("id", id).put("t", e.optString("t", ""))
                                 .put("src", src).put("s", "cache"));
                         continue;
@@ -643,15 +713,55 @@
             }
             java.util.ArrayList<String> keys = new java.util.ArrayList<>(missSrc.keySet());
             HashMap<Integer, String> byIdx = new HashMap<>();
+            HashMap<Integer, String> whyByIdx = new HashMap<>();
+            long deadline = t0 + TT_BUDGET_MS;
             if (google) {
+                // По умолчанию «пачка оборвана по 429»; каждый осмотренный
+                // элемент перезапишет причину своей собственной.
+                for (int i = 0; i < keys.size(); i++) whyByIdx.put(i + 1, "cool");
                 // Free web endpoint: one GET per title, best effort. A failed item
                 // keeps the original title and gets no marker.
                 for (int i = 0; i < keys.size(); i++) {
-                    try {
-                        String one = ttGoogle(missSrc.get(keys.get(i)), lang);
-                        if (one != null && !one.trim().isEmpty()) byIdx.put(i + 1, one);
-                    } catch (Throwable e) {
-                        android.util.Log.w("VotBridge", "title_tr google item: " + e);
+                    String src = missSrc.get(keys.get(i));
+                    String why = "budget";
+                    long i0 = System.currentTimeMillis();
+                    if (i0 < deadline && i0 >= sTtCoolUntil) {
+                        for (int att = 0; att <= TT_RETRIES; att++) {
+                            if (att > 0) {
+                                long wait = Math.min(TT_RETRY_MS * att,
+                                        deadline - System.currentTimeMillis() - 400);
+                                if (wait <= 0) break;
+                                try { Thread.sleep(wait); } catch (InterruptedException ie) { }
+                            }
+                            try {
+                                byIdx.put(i + 1, ttGoogle(src, lang));
+                                why = "ok";
+                                break;
+                            } catch (IOException e) {
+                                why = e.getMessage() == null ? "err" : e.getMessage();
+                            }
+                            if (!ttRetryable(why)) break;
+                        }
+                    } else if (i0 < sTtCoolUntil) {
+                        why = "cool";
+                    }
+                    whyByIdx.put(i + 1, why);
+                    // ≤120 символов на строку; ok — только для первых 8, чтобы по
+                    // логу было видно, что пачка идёт, а не только итоговый счёт.
+                    if (!why.equals("ok") || i < 8) {
+                        android.util.Log.i("VotBridge", "title_tr item n=" + (i + 1) + "/"
+                                + keys.size() + " h=" + keys.get(i).substring(0, 8)
+                                + " len=" + src.length() + " why=" + why
+                                + " ms=" + (System.currentTimeMillis() - i0));
+                    }
+                    // 429 — не сбой одного элемента: остальные получат то же, поэто­му
+                    // пачку обрываем, а следующие 60 с отвечаем из кэша (why=cool).
+                    if (why.equals("http429")) {
+                        sTtCoolUntil = System.currentTimeMillis() + TT_COOL_MS;
+                        break;
+                    }
+                    if (i + 1 < keys.size()) {
+                        try { Thread.sleep(TT_GAP_MS); } catch (InterruptedException ie) { }
                     }
                 }
             } else {
@@ -687,39 +797,55 @@
                 }
             }
             long now = System.currentTimeMillis();
-            int okN = 0, failN = 0;
+            int okN = 0, failN = 0, noopN = 0;
             for (int i = 0; i < keys.size(); i++) {
                 String key = keys.get(i);
                 String src = missSrc.get(key);
                 // Providers number from 1; accept 0-based when 1-based is absent.
                 String cand = byIdx.containsKey(i + 1) ? byIdx.get(i + 1) : byIdx.get(i);
-                if (cand != null && ttValid(src, cand)) {
+                JSONArray ids = missIds.get(key);
+                if (cand != null && ttSame(src, cand)) {
+                    // Переводить нечего (бренд/латиница/уже русский): запоминаем
+                    // «noop» на 30 дней, иначе каждый новый экран просит снова.
+                    JSONObject e = new JSONObject();
+                    e.put("noop", 1).put("src", src).put("at", now);
+                    cache.put(key, e);
+                    if (ids != null) {
+                        for (int q = 0; q < ids.length(); q++) {
+                            skips.put(new JSONObject().put("id", ids.optString(q))
+                                    .put("why", "noop").put("src", src));
+                        }
+                    }
+                    noopN++;
+                } else if (cand != null && ttValid(src, cand)) {
                     String t = ttNorm(cand);
                     JSONObject e = new JSONObject();
                     e.put("t", t).put("src", src).put("at", now);
                     cache.put(key, e);
-                    JSONArray ids = missIds.get(key);
                     if (ids != null) {
                         for (int q = 0; q < ids.length(); q++) {
                             trs.put(new JSONObject().put("id", ids.optString(q)).put("t", t)
-                                    .put("src", src).put("s", "llm"));
+                                    .put("src", src).put("s", google ? "google" : "llm"));
                         }
                     }
                     okN++;
                 } else {
-                    JSONArray ids = missIds.get(key);
+                    String why = whyByIdx.containsKey(i + 1) ? whyByIdx.get(i + 1)
+                            : (cand == null ? "no_translation" : "invalid");
                     if (ids != null) {
                         for (int q = 0; q < ids.length(); q++) {
-                            fails.put(new JSONObject().put("id", ids.optString(q)).put("why", "invalid"));
+                            fails.put(new JSONObject().put("id", ids.optString(q)).put("why", why));
                         }
                     }
                     failN++;
                 }
             }
-            if (okN > 0) titleCacheSave(cache);
+            if (okN > 0 || noopN > 0) titleCacheSaveThrottled(cache);
             long ms = System.currentTimeMillis() - t0;
             android.util.Log.i("VotBridge", "title_tr n=" + missSrc.size() + " ok=" + okN
-                    + " fail=" + failN + " cache=" + cache.length() + " ms=" + ms);
+                    + " fail=" + failN + " noop=" + noopN + " skip=" + skips.length()
+                    + " cache=" + cache.length() + " ms=" + ms
+                    + (System.currentTimeMillis() < sTtCoolUntil ? " cool" : ""));
             out.put("ok", 1).put("lang", lang).put("tr", trs).put("skip", skips)
                     .put("fail", fails).put("ms", ms);
             return out.toString();
```

Что изменилось по пунктам L-0003: (1) причины различимы — `why` в логе и в
`fail.why` для JS; (2) лог ≤120 символов на элемент + итог; (3) пачка 12, пауза
160 мс, 1 ретрай 600 мс, обрыв пачки по 429 + кулдаун 60 с, single-flight,
бюджет 6 с, порядок сохраняется; (9) `noop` больше не `fail` и кэшируется.

## A6. Что осталось за кадром (и почему)

- **`cyrShare >= 0.6` не трогаю** — смешанные заголовки («ОБЗОР iPhone 17 Pro»,
  0.36) и бренды всё равно уходят в `noop`, а понижение порога начнёт отправлять
  уже русские названия. Правильный рычаг — `noop`-кэш, он в патче.
- **Полный аудит `fail` на живой сетке** — нужен стенд; по коду причины выше
  исчерпывают список.

---

# B. Подстановка в DOM

## B5. `el.textContent = tr` (`vot.js:5499`)

`ttApply` пропускает только узлы с `children.length > 1` (`5533`), то есть узел
с **одним** ребёнком проходит — и `textContent = tr` уничтожает этого ребёнка.
Что это значит на YTLR:

- `<yt-formatted-string><span class="...">Название</span></yt-formatted-string>`
  → span выброшен, остаётся голый текстовый узел. Клиент держит ссылки на свои
  узлы и при следующем обновлении пишет в отсоединённый узел: заголовок
  «замирает» или мигает (клиент перерисовывает плитку целиком).
- Если внутри названия были руны/бейджи/иконки (`LIVE`, длительность, «NEW»),
  они исчезают вместе с потомками.
- Если фокус стоял на дочернем узле, он уезжает на `body` — на пульте это
  ощущается как «сброс фокуса» посреди навигации.
- Обратной операции нет: `data-vot-tt` остаётся, а вернуть оригинал нечем
  (см. B8).

Правка: подменять **текстовый узел** (`node.nodeValue`), а не `textContent`
элемента, и требовать «чистый лист» (ни одного дочернего элемента). Скан
`ttApply` и так перебирает всех потомков карточки, поэтому лист всегда будет
найден сам — условие `children.length > 1` просто становится `> 0`.

## B6. Маркер: `span` внутри листа

`ttMarkDot()` (`5479-5492`) добавляет `<span>` **внутрь** названия. Проблемы:

1. `textContent` его не меняет (текста в нём нет), но `el.children.length` из 0
   становится 1 — узел остаётся «листом» по старой проверке `> 1` и продолжает
   сканироваться. Если переведённая строка случайно окажется ключом кэша
   (название одного ролика = перевод другого), её переведут второй раз, а
   `textContent = tr` при этом снесёт маркер и приклеит новый.
2. Маркер участвует в раскладке клиента: при обрезке длинного названия
   многоточием inline-block ребёнок может быть обрезан или «съесть» место под
   многоточие.
3. При перерисовке плитки клиент пересоздаёт текст — маркер исчезает, атрибут
   остаётся (а с ним и ложное «уже переведено», см. B8).

Безопасный вариант — **CSS `::after` по атрибуту**, ноль новых узлов:

```css
[data-vot-tt]::after{content:"";display:inline-block;width:8px;height:8px;
  border-radius:50%;background:#3ea6ff;margin:0 0 1px 7px;vertical-align:middle;
  pointer-events:none;opacity:.9}
```

`::after` идемпотентен (задвоиться не может), в `textContent` не попадает, на
`ttNormText` не влияет, переживает перерисовку текста (атрибут остаётся на
элементе) и снимается вместе с атрибутом. Это и стоит в патче; `ttMarkDot`
удаляется.

## B7. MutationObserver и наши собственные записи

`setupTitleTr` (`5556-5558`) слушает `childList+subtree` на `documentElement`,
каждая наша запись в текстовый узел — это тоже мутация (замена text-node идёт
как `characterData`/childList в зависимости от способа записи).

Реальный риск — не бесконечный цикл (второй проход не находит совпадений и сам
себя останавливает), а **дребезг**: каждая подстановка планирует ещё один
полный проход по документу (`querySelectorAll(TT_CARDS)` + до 40-90 карточек ×
их потомки, до нескольких тысяч узлов). На 20-40 плитках при скролле это
заметно на Cobalt 720p.

Важно: патч B5/B6 убирает саму причину. `el.textContent = tr` заменяет дочерние
узлы — это `childList`-мутация, её observer и ловит. Запись `node.nodeValue = tr`
даёт только `characterData`, а его мы не слушаем — то есть после патча наши
подстановки **не порождают ни одного вызова observer**. Остаются:

1. `ttMo.takeRecords()` после пачки — страховка на случай, если позже в
   `observe(...)` добавят `characterData`;
2. `ttApplySoon` уважает **ближайший** дедлайн (раньше `if (ttApplyTimer) return`
   отбрасывал срочный вызов, если уже стоял 700-мс таймер);
3. `WeakSet` не нужен: `hits >= 40` и идемпотентность `ttApplyOne` уже
   ограничивают объём.

## B8. `data-vot-tt`: recycle, смена языка, выключение pref

Сейчас атрибут хранит только `hash(src)` (`5501`), поэтому:

- **Recycle плитки.** Клиент переиспользует узел под другой ролик и меняет
  текст, атрибут остаётся. `ttApplyOne` видит `data-vot-tt === hash(src_нового)`?
  Нет — значит переведёт заново (это случайно работает), но если новый текст
  совпал с прежним `src` (одинаковые названия у серий) — не переведёт никогда,
  даже если кэш обновился.
- **Клиент вернул оригинал** (перерисовка): текст снова `src`, атрибут говорит
  «переведено» → подстановка не повторяется, карточка остаётся с оригиналом.
- **Выключение pref.** `ttApply` при `!ttEnabled()` просто выходит (`5507`),
  обработчик `vot-pref` зовёт `ttApplySoon(100)` → тот же ранний выход.
  **Перевод остаётся на экране до перезагрузки страницы** — прямое нарушение
  «перевод обязан вернуться к оригиналу».
- **Смена языка** (`ttPump` жёстко шлёт `lang:'ru'`, `5446`): L1-кэш не знает
  про язык, а старые подстановки невалидны.

Правка: держать `data-vot-orig` (сам источник), по нему отличать три состояния
(наш перевод / клиент вернул оригинал / плитка другого ролика), и добавить
`ttRestoreAll()` — обход `[data-vot-tt]`, возврат текста из `data-vot-orig`,
снятие атрибутов. Вызывается при `titleTr.enabled=false` и при
`titleTr.lang`. Обратная подстановка бесплатна: маркер живёт в CSS.

## B9. `ttValid` и порог `cyrShare >= 0.6`

- **Бренды/латиница.** `ttWanted` (`vot.js:5407`) требует хоть одну букву и
  кириллицы < 0.6 — «iPhone 17 Pro» проходит, Google возвращает то же самое,
  `ttValid` → false, `fail`, и так каждый раз. Лечится `noop`-кэшем (A5), а не
  порогами: любая эвристика «это бренд» ошибается на «ОБЗОР iPhone» и на
  названиях каналов.
- **Смешанные.** «ОБЗОР iPhone 17 Pro» (cyr 0.36) — переводить нечего, NMT
  вернёт ту же строку → `noop`. Понижать порог до 0.3 вредно: начнём отправлять
  русские названия с одним латинским словом.
- **Эмодзи.** `ttValid` их не трогает; названия без букв отсекает `ttWanted`
  (`hasLetter`) — правильно.
- **CAPS.** Google обычно сохраняет регистр на коротких строках; если сгладит —
  это допустимо (не ошибка), `ttValid` не должен на это реагировать. Порог
  `len*2+20` оставляю: он ловит «объяснения» LLM, а не NMT.

Итог: пороги не меняем, добавляем `noop` (и на мосту, и в L1-сессии), плюс
`ttNoop` в фильтре очереди — иначе после выключения экрана те же названия
спрашиваются снова.

## B10. Патчи `dev_server/vot.js` и `dev_server/vot_net.js`

```diff
--- a/dev_server/vot.js
+++ b/dev_server/vot.js
@@ -5375,7 +5375,7 @@
   var TT_CARDS = 'ytlr-tile-renderer,ytlr-compact-tile-renderer,'
     + 'ytlr-video-with-context-renderer,ytlr-compact-video-renderer,'
     + 'ytlr-playlist-renderer,ytlr-channel-renderer,[role="gridcell"]';
-  var ttCache = {}, ttPending = {}, ttQueue = [], ttBusy = 0;
+  var ttCache = {}, ttNoop = {}, ttPending = {}, ttQueue = [], ttBusy = 0;
   var ttApplyTimer = 0, ttCooldown = 0, ttOkCount = 0, ttLastLog = 0;
 
   function ttNormText(s) {
@@ -5426,7 +5426,7 @@
     for (var i = 0; i < list.length; i++) {
       var it = list[i] || {};
       var t = ttNormText(it.t);
-      if (!ttWanted(t) || ttCache[t] || ttPending[t]) continue;
+      if (!ttWanted(t) || ttCache[t] || ttNoop[t] || ttPending[t]) continue;
       ttPending[t] = 1;
       ttQueue.push({ id: String(it.id || ''), t: t });
       added++;
@@ -5439,32 +5439,56 @@
   function ttPump() {
     if (ttBusy > 0 || !ttQueue.length || !ttEnabled()) return;
     if (Date.now() < ttCooldown) { ttQueue.length = 0; return; }
-    var batch = ttQueue.splice(0, 20), items = [], i;
+    // 12 — это один экран поиска; больше не влезает в бюджет провайдера
+    // (один GET на название), остальное уходит следующим тиком.
+    var batch = ttQueue.splice(0, 12), items = [], i;
     for (i = 0; i < batch.length; i++) items.push({ id: batch[i].id, t: batch[i].t });
     ttBusy++;
     var t0 = Date.now();
     http('POST', '/title_tr', { v: 1, lang: 'ru', items: items }, function (r) {
       ttBusy--;
-      var ok = 0, k;
+      var ok = 0, nSkip = 0, nFail = 0, k;
       if (!r || r.ok === 0) {
         // Нет ключа/провайдер недоступен: не долбим мост каждым ответом сетки.
         ttCooldown = Date.now() + 300000;
         log('title_tr off ' + ((r && r.why) || 'bad'));
-      } else if (r.tr) {
-        for (k = 0; k < r.tr.length; k++) {
-          var e = r.tr[k] || {};
-          var src = ttNormText(e.src), tr = ttNormText(e.t);
-          if (!src || !tr || !ttWanted(src) || tr === src || tr.length > 160) continue;
-          ttCache[src] = tr;
-          ok++;
+      } else {
+        if (r.tr) {
+          for (k = 0; k < r.tr.length; k++) {
+            var e = r.tr[k] || {};
+            var src = ttNormText(e.src), tr = ttNormText(e.t);
+            if (!src || !tr || !ttWanted(src) || tr === src || tr.length > 160) continue;
+            ttCache[src] = tr;
+            ok++;
+          }
+        }
+        // «Нечего переводить» (бренд, латиница, уже русский) — не ошибка, но и
+        // не перевод: помним на сессию, иначе каждый экран спрашивает снова.
+        if (r.skip) {
+          for (k = 0; k < r.skip.length; k++) {
+            var sk = r.skip[k] || {};
+            if (sk.why === 'noop' && sk.src) { ttNoop[ttNormText(sk.src)] = 1; nSkip++; }
+          }
+        }
+        // Мост на паузе (429/cooldown): не возвращаемся к нему 30 с.
+        if (r.fail) {
+          for (k = 0; k < r.fail.length; k++) {
+            var fl = r.fail[k] || {};
+            nFail++;
+            if (fl.why === 'rate' || fl.why === 'cool' || fl.why === 'http429') {
+              ttCooldown = Date.now() + 30000;
+              break;
+            }
+          }
         }
       }
       for (k = 0; k < batch.length; k++) delete ttPending[batch[k].t];
       ttOkCount += ok;
       if (Date.now() - ttLastLog > 3000 || ok === 0) {
         ttLastLog = Date.now();
-        log('title_tr n=' + batch.length + ' ok=' + ok + ' ms='
-          + ((r && r.ms) || (Date.now() - t0)) + ' total=' + ttOkCount);
+        log('title_tr n=' + batch.length + ' ok=' + ok + ' skip=' + nSkip
+          + ' fail=' + nFail + ' ms=' + ((r && r.ms) || (Date.now() - t0))
+          + ' total=' + ttOkCount);
       }
       if (ok) ttApplySoon(0);
       ttPump();
@@ -5476,32 +5500,54 @@
     });
   }
 
-  function ttMarkDot() {
-    var d = document.createElement('span');
-    d.className = 'vot-tt-dot';
-    d.style.display = 'inline-block';
-    d.style.width = '9px';
-    d.style.height = '9px';
-    d.style.borderRadius = '50%';
-    d.style.background = '#3ea6ff';
-    d.style.marginLeft = '8px';
-    d.style.verticalAlign = 'middle';
-    d.style.flex = '0 0 auto';
-    d.setAttribute('aria-hidden', 'true');
-    return d;
-  }
-
-  // Подменяем только листовой узел, чей текст в точности равен названию из
-  // ответа сетки. data-vot-tt хранит хеш источника: при recycle плитки текст
-  // меняется, хеш не совпадает — и карточка переводится заново.
+  // Текст листа: ровно один непустой текстовый узел и ни одного дочернего
+  // элемента. Возвращаем узел, а не элемент: подмена nodeValue не убивает
+  // детей (руны, бейджи, иконки), не снимает слушатели и не сбрасывает фокус.
+  function ttLeafTextNode(el) {
+    if (!el || (el.children && el.children.length)) return null;
+    var node = null;
+    for (var c = el.firstChild; c; c = c.nextSibling) {
+      if (c.nodeType !== 3) continue;
+      if (!/\S/.test(c.nodeValue || '')) continue;
+      if (node) return null;          // несколько текстовых узлов — неоднозначно
+      node = c;
+    }
+    return node;
+  }
+
+  // data-vot-tt — хеш источника, data-vot-orig — сам источник. По ним видно,
+  // наш перевод стоит, клиент вернул оригинал или плитку отдали другому ролику.
+  // Маркер — CSS ::after по атрибуту (ставится в setupTitleTr), поэтому он не
+  // попадает в textContent, не задваивается и не мешает сравнению строк.
   function ttApplyOne(el, src, tr) {
-    if (el.getAttribute('data-vot-tt') === ttHash(src)) return false;
-    try { el.textContent = tr; } catch (e) { return false; }
-    el.appendChild(ttMarkDot());
+    var node = ttLeafTextNode(el);
+    if (!node) return false;
+    if (ttNormText(node.nodeValue) !== src) return false;
+    try { node.nodeValue = tr; } catch (e) { return false; }
     el.setAttribute('data-vot-tt', ttHash(src));
+    el.setAttribute('data-vot-orig', src);
     return true;
   }
 
+  // Выключили pref (или сменили язык) — оригиналы обязаны вернуться, а не
+  // остаться до перезагрузки страницы. Маркер живёт в CSS и снимается вместе
+  // с атрибутом.
+  function ttRestoreAll() {
+    var list = null, n = 0, i;
+    try { list = document.querySelectorAll('[data-vot-tt]'); } catch (e) { return 0; }
+    for (i = 0; i < list.length; i++) {
+      var el = list[i];
+      var src = el.getAttribute('data-vot-orig') || '';
+      var node = ttLeafTextNode(el);
+      if (node && src && ttNormText(node.nodeValue) !== src) {
+        try { node.nodeValue = src; n++; } catch (e2) { }
+      }
+      el.removeAttribute('data-vot-tt');
+      el.removeAttribute('data-vot-orig');
+    }
+    return n;
+  }
+
   function ttApply() {
     ttApplyTimer = 0;
     if (!ttEnabled()) return;
@@ -5530,42 +5576,91 @@
       }
       for (j = 0; j < nodes.length; j++) {
         var el = nodes[j];
-        if (el.children && el.children.length > 1) continue;
+        // Только чистый лист: у элемента с детьми textContent трогать нельзя.
+        if (el.children && el.children.length) continue;
+        if (el.closest && el.closest('#vot-ui-root')) continue;
         var tx = ttNormText(el.textContent);
+        // Атрибут от прошлой подстановки: либо наш перевод ещё стоит, либо
+        // плитку переиспользовали и атрибут надо снять.
+        var mark = el.getAttribute ? el.getAttribute('data-vot-tt') : null;
+        if (mark) {
+          var osrc = el.getAttribute('data-vot-orig') || '';
+          if (osrc && ttCache[osrc] === tx) continue;       // перевод на месте
+          if (osrc && tx === osrc) {                        // клиент вернул оригинал
+            if (ttApplyOne(el, osrc, ttCache[osrc])) { hits++; if (hits >= 40) break; }
+            continue;
+          }
+          el.removeAttribute('data-vot-tt');
+          el.removeAttribute('data-vot-orig');
+        }
         if (!tx || tx.length > 120) continue;
-        var tr = ttCache[tx];
-        if (!tr) continue;
-        if (el.closest && el.closest('#vot-ui-root')) continue;
-        if (ttApplyOne(el, tx, tr)) { hits++; if (hits >= 40) break; }
+        if (ttApplyOne(el, tx, ttCache[tx])) { hits++; if (hits >= 40) break; }
       }
     }
-    if (hits) log('title_apply n=' + hits);
+    if (hits) {
+      // Наши записи не должны будить observer: снимаем накопленные записи,
+      // иначе каждая подстановка планирует ещё один полный проход.
+      try { if (ttMo) ttMo.takeRecords(); } catch (e4) { }
+      log('title_apply n=' + hits);
+    }
   }
 
+  var ttApplyAt = 0;
   function ttApplySoon(delay) {
-    if (ttApplyTimer) return;
+    var at = Date.now() + (delay == null ? 400 : delay);
+    if (ttApplyTimer) {
+      if (at >= ttApplyAt) return;      // уже запланировано не позже
+      clearTimeout(ttApplyTimer);
+    }
+    ttApplyAt = at;
     ttApplyTimer = setTimeout(function () {
-      try { ttApply(); } catch (e) { ttApplyTimer = 0; log('title_apply err ' + (e && e.message)); }
-    }, delay == null ? 400 : delay);
+      ttApplyTimer = 0; ttApplyAt = 0;
+      try { ttApply(); } catch (e) { log('title_apply err ' + (e && e.message)); }
+    }, Math.max(0, at - Date.now()));
   }
 
+  var ttMo = null;
   function setupTitleTr() {
     if (window.__votTitleBatch) return;
     window.__votTitleBatch = ttBatch;
+    // Маркер «переведено»: один раз на документ, дальше только атрибут на
+    // названии — ни новых узлов в плитке, ни символов в textContent.
+    try {
+      if (!document.getElementById('vot-tt-style')) {
+        var st = document.createElement('style');
+        st.id = 'vot-tt-style';
+        st.textContent = '[data-vot-tt]::after{content:"";display:inline-block;'
+          + 'width:8px;height:8px;border-radius:50%;background:#3ea6ff;'
+          + 'margin:0 0 1px 7px;vertical-align:middle;pointer-events:none;opacity:.9}';
+        (document.head || document.documentElement).appendChild(st);
+      }
+    } catch (e3) { }
     try {
-      var mo = new MutationObserver(function () { ttApplySoon(700); });
+      ttMo = new MutationObserver(function () { ttApplySoon(700); });
       // childList+subtree: YTLR пересобирает плитки при скролле и смене ленты.
-      mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
+      // characterData не слушаем: наши записи в text-node иначе будили бы цикл,
+      // а после пачки мы ещё и снимаем накопленные записи (takeRecords).
+      ttMo.observe(document.documentElement || document.body, { childList: true, subtree: true });
     } catch (e0) { }
     // Страховка для recycle без childList: раз в 4 с, только при живом кэше.
     setInterval(function () {
       try {
-        if (ttEnabled() && document.visibilityState !== 'hidden') ttApplySoon(50);
+        if (!ttEnabled()) return;
+        if (document.visibilityState !== 'hidden') ttApplySoon(50);
       } catch (e1) { }
     }, 4000);
     try {
       window.addEventListener('vot-pref', function (e) {
-        if (e && e.detail && e.detail.key === 'titleTr.enabled') ttApplySoon(100);
+        var k = e && e.detail && e.detail.key;
+        if (k === 'titleTr.enabled') {
+          if (!ttEnabled()) { log('title_restore n=' + ttRestoreAll()); return; }
+          ttApplySoon(100);
+        } else if (k === 'titleTr.lang') {
+          // Язык перевода сменился — старые подстановки невалидны.
+          log('title_restore lang n=' + ttRestoreAll());
+          ttCache = {}; ttNoop = {};
+          ttApplySoon(100);
+        }
       });
     } catch (e2) { }
     log('title_tr hook ready');
```

```diff
--- a/dev_server/vot_net.js
+++ b/dev_server/vot_net.js
@@ -945,7 +945,9 @@
       nodes++;
       if (!n || typeof n !== 'object') continue;
       if (Object.prototype.toString.call(n) === '[object Array]') {
-        for (i = 0; i < n.length; i++) stack.push(n[i]);
+        // stack.pop() берёт последний: pushed в обратном порядке, чтобы обход
+        // шёл в порядке ответа (первая карточка экрана — первой в очереди).
+        for (i = n.length - 1; i >= 0; i--) stack.push(n[i]);
         continue;
       }
       var id = n.videoId;
```

Коротко: `ttApplyOne` пишет `nodeValue` и хранит `data-vot-orig`; `ttApply`
берёт только чистые листы, распознаёт recycle и умеет повторную подстановку;
маркер — CSS `::after`; `setupTitleTr` ставит стиль один раз, держит observer в
`ttMo`, снимает свои записи через `takeRecords()` и по `vot-pref` либо
восстанавливает оригиналы (`ttRestoreAll`), либо чистит кэш при смене языка;
`ttPump` понимает `skip.why=noop` и `fail.why=rate|cool`; пачка — 12.

## B11. Чек-лист проверки на устройстве

1. `adb logcat -s VotBridge | grep title_tr` — на экране поиска (12 карточек):
   `title_tr n=12 ok=… fail=… noop=… ms=…`, `ok >= 10`, у каждого не-ok видна
   `why` (`http429/html/json/budget/cool`), ни одного «молчаливого» fail.
2. Выйти из поиска и вернуться — `s=cache`, `ms < 100`, новых `item`-строк нет.
3. Открыть ленту с брендами (`iPhone`, `NVIDIA`) — они уходят в `skip=noop` и
   **не** появляются в следующем провайдерском вызове.
4. Оверлей-лог: `title_apply n=<число>` один раз на экран (не поток), после него
   нет лавины повторных `title_apply` от observer.
5. Фокус: пройти пультом по переведённой плитке, нажать OK — переход на ролик,
   фокус не «прыгает» (проверка, что потомки/фокус не убиты).
6. LIVE-плитка и плитка с длительностью: бейдж `LIVE` и таймер на месте, точка
   маркера видна справа от названия, длинное название обрезается с `…` как
   раньше.
7. Панель настроек → выключить «перевод названий» → `title_restore n=<N>`,
   названия вернулись к оригиналу без перезагрузки; включить — перевелись снова.
8. Смена языка (если появится) — старые подстановки исчезают, `title_restore
   lang`.
9. Регрессии: перевод звука стартует как раньше (`translate start`), панель
   фильтров поиска работает (её `params` не менялись), OK на пульте не съедается.

---

# C. Риски, которые не правил

| Риск | Почему не правил |
|---|---|
| Один GET на название (нет батча без ключа) | без ключа батча не существует (A4); менять провайдера — решение продукта |
| `ttWalk` дедуп по `videoId` и лимит 60 | изменит объём трафика и порядок; нужен замер на живых лентах |
| `lang:'ru'` захардкожен в `ttPump` | UI-настройки ещё нет; патч B10 уже готов к `titleTr.lang` |
| `ttScanText` требует `{` первым символом | ответы с BOM/пробелом теряются, но это редкость и без стенда не проверить |
| Кэш на 30 дней без ручного сброса | в панели нет пункта; добавление пункта — отдельная UI-задача |
| `cyrShare` на мосту и в JS расходятся в трактовке CJK | латиница+кириллица покрывают текущие ленты, менять оба синхронно |
| Патч меняет `ttGoogle` (read timeout 9 с → 4 с) | 4 с достаточно для 200-байтного ответа; вернуть, если появятся таймауты в логе |
