# STATE — TizenTubeCobalt + Yandex VOT (25.10.2026)

## Цель
Живые голоса Яндекса (VOT) в TizenTubeCobalt на Samsung TV
(`adb -s 192.168.1.100:5555`, `io.gh.reisxd.tizentube.cobalt`, `…/dev.cobalt.app.MainActivity`),
**serverless**: в рантайме только API Яндекса + статика GitHub, без ПК/своего сервера.
UI — JS-оверлей (IPv4 без пересборки APK). Ветка `fix-vot-runtime-injection`, PR в `main` не делать.
Полная история решений и прогонов — `STATE_ARCHIVE.md` (детали там, здесь только актуальное).

## Что уже работает (проверено на ТВ)
- Перевод E2E: кэш Яндекса шардирован по языку (поле 8), лестница `status=6/0` → ПК-филлер →
  `status=2` → `1` → `play`; кнопка 文A в баре = выключатель, пункт «Перевод Яндекс» в шестерёнке,
  ползунки «Громкость перевода»/«Оригинал при переводе» (шаг 10 %, `POST /volume` в мосту).
- Язык оригинала ≤0.6 с через `/youtubei/v1/player`; `skipLang=ru` (русские ролики не переводим).
- Мост (dex 51 628 B **установлен**) отдаёт `/yt_session`, `/yt_url`, `/meta_local`, `/config`
  с полями `audioMode` (`off|local`) и `pcFill`.
- Ревью пройдено (0 blocker): исправлены 2 MAJOR (частичный `sCookieMap` при исключении; фильтр
  истёкших куки), точный SQL по хосту, `os.close()` перед `getResponseCode()`. Новый dex
  **51 672 B собран, но НЕ установлен** (установка убьёт текущий вход — только после проверки сессии).
- Serverless-обвязка живая: `/yt_url?videoId=dQw4w9WgXcQ` (ANDROID_VR, анонимно) → 4 аудио-формата
  с прямыми url, `n=false`, `ciphered=0`; `/meta_local` → `ok:true, lang=en, client=WEB`.
- В JS есть ветки `audioMode=local`: `bridgeAudio()` (приоритет `251`→`140`→любой url без `n`) и
  `fetchMetaLocal()` с тихим откатом на ПК-мету.

## Блокер (главное)
- «Холодные» ролики без живого логина: и `WEB`, и `ANDROID_VR` → `LOGIN_REQUIRED
  "Sign in to confirm you're not a bot"`, форматов 0 (`hTWKbfoikeg`).
- Сессия YouTube на ТВ НЕ получена: в `Cookies` 12 анонимных куки, авторизационных 0.
- С живым логином `WEB`/`TVHTML5` дают аудио **SABR-only** (`serverAbrStreamingUrl`) ⇒ прямых url нет.
- 403 на googlevideo = невыполненный параметр `n` (есть `n` → 403, нет → 206); `poToken` не нужен.
- Бот-гейт реагирует на частоту запросов с IP: ≥3 player-запроса подряд → отказ ~150 с.

## Путь к serverless-аудио (вердикт `architect`, 25.10)
- Основной путь — **A: UMP/SABR-выгрузка в Java** (`serverAbrStreamingUrl` → fMP4 → файл → `/audio`),
  ~2–3K строк, нужен живой логин. Сначала критический эксперимент: GET/POST на SABR-url с куками —
  `206` ⇒ A жива; `403`/требует `pot` ⇒ A + poToken через WebView Яндекса.
- Быстрая страховка: клиент `WEB_EMBEDDED_PLAYER` (1 запрос) — может дать прямые url без `n`.
- `poToken` в чистом V8 Cobalt нереализуем (нет DOM/WASM) — только WebView.
- Путь D (наш, дешёвый): перехват в странице того, что штатный плеер ТВ уже скачал.
  Зонд `dev_server/vot_net.js` (вклеен в `/vot.js`, лимит 40 строк лога): player-ответ,
  player_response из `ytcfg`, запросы к `googlevideo.com` — по логу видно, есть ли прямые url.

## Следующие шаги
1. Живой логин на ТВ по QR и проверка `/yt_session` **без** `am force-stop` (он теряет куки).
2. Прочитать лог зонда `[VOT-net]` после перезапуска приложения (нужен рестарт оверлея).
3. Эксперимент по вердикту: SABR-url (`CevxZvSJLk8`) → `206`? и `WEB_EMBEDDED_PLAYER` (1 запрос).
4. E2E serverless: `audioMode=local` + `pcFill=false` в `dev_server/vot_config.json` (мост подхватит
   за ≤8 с), холодный иностранный ролик → `/yt_url` → `/audio` → `status=1` → `play`.
5. Ревью + коммит: `STATE.md`, `STATE_ARCHIVE.md`, `dev_server/vot.js`, `vot_net.js`,
   `serve_vot.py`, `vot_bridge/java/vot/Bridge.java`.


## Грабли (не наступать)
- **Нельзя `am force-stop`** после входа: Cobalt теряет незаписанные куки (маркер
  `unexpected-restart-dirty-bit-cookie`). Выход — только штатный.
- Логи ТВ: только `adb -s 192.168.1.100:5555 logcat -d -s VotBridge`; нефильтрованный `logcat -d` — нет.
- Мост слушает `127.0.0.1:8013`; с ПК — `adb forward tcp:18013 tcp:8013`.
- Репо sparse-checkout: новые файлы вне списка — `git add --sparse` или дописать путь в
  `.git/info/sparse-checkout`.
- Dev-сервер: `C:\Program Files\Python311\python.exe dev_server\serve_vot.py` (`/ping` → `pong`).
- CSS-анимации в Cobalt не идут: анимации/шкала — покадрово из JS (`requestAnimationFrame`).
