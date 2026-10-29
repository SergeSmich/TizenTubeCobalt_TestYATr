# STATE — TizenTubeCobalt + Yandex VOT (24.10.2026)

## 1. Цель
Живые голоса Яндекса в TizenTubeCobalt на Samsung TV (`adb -s 192.168.1.100:5555`,
`io.gh.reisxd.tizentube.cobalt`, активити `…/dev.cobalt.app.MainActivity`): быстрый старт,
без отказов и заикания. UI — только JS-оверлей (без пересборки APK).

## 1a. Синхронизация с GitHub (25.10) — ВЫПОЛНЕНО
- Ветка `fix-vot-runtime-injection`: наши 12 коммитов пересажены **rebase**'ом на удалённые 10
  (линейная история, без merge) ⇒ `0 behind / 12 ahead`, push fast-forward
  `f112235662d..2d8e4215249`. На `origin` теперь `2d8e42152498d64a9d156ca1139870fc2c4a02e9`.
- Единственный конфликт — `patch_tizentube_userscript_url.py`: сохранены наш env-override
  (`DEV_URL_ENV="VOT_SCRIPT_URL"` → локальный дев-сервер) и свежий URL с удалёнки (`@6543a34`);
  `ast.parse` OK.
- Содержимое пересаженных коммитов сверено по blob-хэшам со старыми — идентично (`vot.js`,
  `vot_ui.js`, `serve_vot.py`, `Bridge.java`, `fill_audio.py`, `yt_lang.py` = SAME), правки
  удалённых 10 коммитов не потеряны.
- Новые SHA (старые `ae419c0`, `f2e39b82fae`, `a6cca6dca0c`, `2e12e86e670`, `5d5053e6302`,
  `96bce92eb50` в ветке больше НЕ существуют, в тексте ниже проставлены новые):
  `89f309220bf` филлер/шарды · `9f5afe8703e` кнопка+панель · `0a824e9782f` STATE ·
  `8d36f60a9f6` пункт в шестерёнке · `1d5697b20c2` нативная панель+громкость · `96bcf367e1e` STATE ·
  `d44a136de95` флаги протокола · `758ce2132d5` STATE · `40697a4ed9a` шкала+гейт языка ·
  `0ba220c1cc1` STATE · `6400f72ff79` фикс интерфейса · `2d8e4215249` `/temp/` в `.gitignore`.
- Бэкап до синхронизации: `backup/pre-sync-2026-10-25` (`1054f54d5b7`). PR в `main` — позже.
- **Грабли (важно)**: репо в sparse-checkout (non-cone), наших путей в списке не было ⇒ после
  `git rebase`/checkout файлы `dev_server/*`, `STATE.md`, `*.py` в корне исчезли с диска
  (в коммитах целы). В `.git/info/sparse-checkout` дописаны `/.gitignore`, `/*.py`, `/*.ps1`,
  `/*.md`, `/dev_server/**`, `/vot_bridge/**`, `/.github/**` + `git sparse-checkout reapply`.
  Бэкап старого списка: `%TEMP%\sparse-checkout.bak`. Новый файл вне списка — либо
  `git add --sparse`, либо сначала дописать путь в sparse-checkout.

## 1f. (25.10 19:0x) Мост: сессия ТВ + InnerTube + /meta_local (dex 51 372 B, НЕ установлен)
`vot_bridge/java/vot/Bridge.java` дополнен под serverless (javac `--release 8` OK, d8 OK):
- `sDataDir`/`sCacheDir` берутся в `start(Context)` → читаем
  `<dataDir>/app_content_shell/content_shell/Cookies`;
- `refreshCookies(force)`: копия БД в cacheDir `vot_cookies.db` + `SQLiteDatabase.openDatabase(...,
  OPEN_READONLY)`, запрос `host_key LIKE '%youtube.com'`, отбрасываем истёкшие (`expires_utc` =
  мкс от 1601), при дубле имени приоритет хосту `.youtube.com`; кэш 60 с; `sCookieHeader`,
  `sCookieMap`, `sCookieLoggedIn` = есть `SID` или `SAPISID`; в лог только имена и длины;
- `itPlayer(videoId, vr)`: POST `/youtubei/v1/player?key=…&prettyPrint=false`; `ANDROID_VR`
  1.62.27 (X-Youtube-Client-Name 28) для прямых url, `WEB` 2.20240101.00.00 + `SAPISIDHASH`
  (SHA-1 от `ts sapisid origin`) для языка;
- эндпоинты: `/yt_session` (диагностика: `loggedIn`,`count`,`auth[]`,`names` — БЕЗ значений),
  `/yt_url?videoId=&client=vr|web` (`{status,reason,title,duration,formats[{itag,mime,clen,url,n}],
  hasN,ciphered,sabr}`), `/meta_local?videoId=` (порт `yt_lang.py`: `lang` из
  `defaultAudioTrackIndex`→`audioTrackId`, фолбэк `captionTracks[0]`, кэш 6 ч / ошибки 2 мин);
- `/config` теперь отдаёт и принимает `audioMode` (`off`|`local`, default `off`) и `pcFill`
  (default `true`) ⇒ JS-ветка `cfg.audioMode` оживает.
Сборка: `vot_bridge/classes4.dex` 51 372 B (+11 136). **APK на ТВ НЕ ставился** (запрет),
поэтому новые эндпоинты живьём не проверены.
Проверка сессии на ТВ после «входа» пользователем: БД `Cookies` 24 576 B, mtime 18:59,
journal пуст, куки youtube = 12, авторизационных (`SID`/`SAPISID`/`APISID`/`LOGIN_INFO`/
`__Secure-1/3PSID`) — **0** ⇒ Cobalt на ТВ по-прежнему анонимный, путь A2 пока мёртв.
Дальше: 1) разрешение на установку APK (иначе serverless-путь не проверить); 2) штатный
выход из Cobalt и повторное снятие `Cookies`; 3) JS-ветка `audioMode=local`: `/yt_url` → url без
`n` (`dQw4w9WgXcQ` отдаёт без `n`) → `/audio` → Яндексу, это E2E-проверка всей обвязки без ПК.

### 1f-1. JS под serverless (25.10 19:2x, `node --check` OK, на ТВ не проверено)
`dev_server/vot.js`:
- `bridgeAudio(videoId, cb, err)` — `GET /yt_url?videoId=…&client=vr`; приоритет `251`→`140`→любой
  audio-формат, но **только без `n`**; лог `audio bridge vr fmt=N withN=M login=1 pick itag=251`;
  если все url с `n` — ошибка `url needs n (M)` (решателя нет);
- `uploadAudio` выбирает источник по `state.cfg.audioMode === 'local'` → `bridgeAudio`, иначе
  прежний `innertubeAudio` (страница); лог `audio lookup … mode=local|page`;
- `fetchMeta` стал диспетчером: `audioMode=local` → `fetchMetaLocal` (`GET /meta_local`), при
  неудаче/ошибке — тихий откат в `fetchMetaPC` (прежний `/fill_status` через ПК);
- в boot-лог добавлены `audio=off|local` и `pcFill=0|1`.
Тестовый переключатель: `audioMode` кладётся в `dev_server/vot_config.json` — мост подхватывает
его за ≤8 с (`reloadConfig`), перезапуск приложения не нужен (нужна установка нового dex).

### 1f-2. (25.10 19:4x) Мост на ТВ: serverless-эндпоинты РАБОТАЮТ (dex 51 628 B установлен)
Новый APK установлен (`adb install -r` = Success), `audioMode`/`pcFill` в `/config` доезжают.
Первый живой прогон (`adb forward tcp:18013 tcp:8013` → запросы с ПК в мост):
- `/yt_session` → `{loggedIn:false, count:12, auth:[], headerLen:841}` — в БД только анонимные,
  в names есть `yt.leanback.default::unexpected-restart-dirty-bit-cookie` ⇒ Cobalt видел
  аварийное завершение (наш `am force-stop`) и мог не сбросить куки на диск;
- `/yt_url?videoId=dQw4w9WgXcQ` (ANDROID_VR, анонимно) → `status=OK`, 4 формата с прямыми url
  (`140` 3 449 447 B, `251` 3 433 755 B), **`n=false`, `ciphered=0`** ⇒ нативный филлер без ПК
  и без WebView технически возможен;
- `/meta_local?videoId=dQw4w9WgXcQ` → `ok:true, lang=en, client=WEB, login:0, 1339ms` ⇒ **язык
  оригинала определяется БЕЗ ПК** (WEB с анонимными куками ТВ);
- «холодный» `hTWKbfoikeg`: и WEB, и ANDROID_VR → `LOGIN_REQUIRED "Sign in to confirm you're
  not a bot"`, форматов 0; VR-фолбэк в `meta_local` отработал (webStatus в JSON), но не спас.
Вывод: serverless-обвязка (url + язык) готова, но произвольные ролики упираются в бот-гейт без
живого логина. С логином по WEB клиенту аудио приходит SABR-only (`serverAbrStreamingUrl`) ⇒
для продукта остаётся либо UMP/SABR-выгрузка в Java, либо poToken/BotGuard в V8 Cobalt.
Грабли: **нельзя делать `am force-stop`** после входа — Cobalt теряет незаписанные куки.

## 1b. (25.10) АУДИТ serverless-перевода: блокер = бот-гейт, а НЕ poToken
Проверено на ПК (матрица 6 InnerTube-клиентов × 15 роликов) и на ТВ. Итоги:
- **Прямые аудио-URL не требуют ни cipher, ни `n`, ни `pot`.** В успешных ответах
  `adaptiveFormats[].url` есть, `signatureCipher` нет, `sig`/`lsig` уже подставлены;
  `Range: bytes=0-1023` → **206**. `serverAbrStreamingUrl` = 0. То есть JS-расшифровка
  и BotGuard/poToken на этом пути НЕ нужны (архитектурный вердикт kimi-k3 про poToken
  для этой схемы неверен).
- **Реальный блокер — бот-гейт по IP+сессии:** из 15 роликов играбелен только
  `dQw4w9WgXcQ`; на остальных все клиенты (ANDROID_VR/IOS/ANDROID/TVHTML5/MWEB/WEB)
  дают `LOGIN_REQUIRED "Sign in to confirm you're not a bot"`. `visitorData` не влияет.
  `400 Precondition check failed` — это устаревший clientVersion, лечится версией:
  IOS 20.29.3, ANDROID 20.29.36, ANDROID_VR 1.62.27 → 200.
- **Мастер-куки `dev_server/yt_cookies.txt` МЁРТВ** (файл цел, mtime тот же, но сессия не
  принимается: `/watch` → `LOGGED_IN:false`, `account/accounts_list` пуст, `yt_lang.py`
  → LOGIN_REQUIRED). Значит и ПК-филлер сейчас НЕ качает: `/fill` → `RuntimeError: нужен
  вход в YouTube: куки не авторизованы`. Нужен новый экспорт из Chrome.
- **`audioMode`/`pcFill` из `vot_config.json` на ТВ не работают**: `Bridge.configJson()`
  (стр. 494-502) отдаёт JS только `lively,hasToken,worker,mediaProxy,proxyMode,faMode`.
  Поэтому нативный путь (`uploadRealAudio`/`innerTubePlayer`) на ТВ — мёртвый код,
  а `pcFill:false` игнорируется. Нужны 2 строки в мосту + пересборка dex.
- ТВ: **YNDX-00091, Android 11 (SDK 30), armv7-only (32 бита!), 3 ГБ RAM (~486 МБ free)**.
  WebView есть только `com.yandex.webview 144.0.7559.226`, fallback выключен,
  `com.google.android.webview` 118 отключён, Chrome/Trichrome и GMS нет.
- Холодные ролики для тестов: `CevxZvSJLk8`, `hTWKbfoikeg`; `DaeWIAqoEfI` и
  `jNQXAC9IVRw` уже в кэше Яндекса (status=1) — как «эталон холодного» больше не годятся.
- Грабли: серия >10 player-запросов подряд без пауз → троттлинг (`ERROR video unavailable`),
  между запросами 2-4 с.
Следующий шаг: свежий cookie-jar → ПК-проба **ANDROID_VR + живая cookie** на 5-10 роликах
(ожидание: прямой url + 206 ⇒ нативный филлер = ~200 строк Java без WebView) + проверка
`run-as` доступа к cookie-хранилищу Cobalt (авторизуется ли ТВ сам).

## 1c. (25.10 17:30–18:0x, ПОДТВЕРЖДЕНО) Живые куки снимают бот-гейт, но не дают 206
Свежий jar `dev_server/yt_cookies.new.txt` (482 835 B, SHA256 `7DF45A77…`, mtime 17:28):
`SID`=5, `SAPISID`=3, `LOGIN_INFO`=1, `__Secure-1PSID`=3 для `.youtube.com` — логин живой,
за прогоны проб файл не изменился (пер-запуск копии работают). Мастер `yt_cookies.txt`
(478 768 B) не тронут, `.bak` на месте.
**Сессия жива и ПОСЛЕ yt-dlp** (проверено 3 способами): `/watch` → `"LOGGED_IN":true`;
`account/accounts_list` → `logged_in=1`; `yt_lang.detect` → en (400 мс). Набор куки у `.new` и
мастера идентичен (25/25), значения `SID/SAPISID/APISID/PSID` совпадают, отличаются только
волатильные (`LOGIN_INFO`, `SIDCC`, `*PSIDTS`) ⇒ yt-dlp jar не ломает, лестница `--cookies` безопасна.
Итог матрицы 12 клиентов × 9 роликов (`probe2_out.txt`, отчёт tester):
- `206` = **0/9 У ВСЕХ 12 вариантов**. Единственный 206 за все опыты — контрольный `dQw4w9WgXcQ`
  (`bytes 0-1023/3449447`, VR 1.60/1.62 ⇒ 1/9).
- Куки снимают бот-гейт: `WEB+ck` и `TVHTML5+ck` = `OK` на 8/9 (без куки `LOGIN_REQUIRED` 8/9),
  **но аудио SABR-only** (у `140/249/250/251` нет ни `url`, ни `signatureCipher`, только
  `streamingData.serverAbrStreamingUrl`); прогрессивный `itag=18` url имеет, но тоже 403.
- `ANDROID_VR`(1.60.19/1.62.27)/`IOS`/`ANDROID` + куки: 7–8 из 9 `LOGIN_REQUIRED`
  (`DaeWIAqoEfI` блокируется даже с куки), у редких OK url есть, но GET → **403**.
- 403 везде: `ct=text/plain`, body пустой, 0 байт, и с Cookie, и без, и с Chrome-UA; в url
  `n=True`, `sig/lsig` уже подставлены, `pot=False` ⇒ причина = невыполненная **n-трансформация**
  (yt-dlp в том же прогоне: `n challenge solving failed`), а не poToken.
- `aVn7jDNzZI` — «This video is unavailable» у всех 12 (ролик мёртв, не блокер).
- Троттлинг подтверждён: ≥3 player-запроса подряд без паузы → `WEB+ck` временно `LOGIN_REQUIRED`,
  восстанавливается после паузы ~150 с.
Размеры аудио (contentLength): `jNQXAC9IVRw` 140=309 288 · `9bZkp7q19f0` 140=4 083 640 ·
`DaeWIAqoEfI` 140=10 499 928 (40 дорожек) · `dQw4w9WgXcQ` 140=3 449 447.
Следующий шаг: решить 403 на прямом URL (трансформация `n` / клиент без `n`), иначе нативный
филлер без JS-расшифровки не собрать; альтернатива — SABR/UMP-поток (дорого для ТВ, 32 бита).

### 1c-1. (25.10 18:2x) Причина 403 найдена: параметр `n` (корреляция 1:1)
`hprobe.py` (4 набора заголовков: голый UA, +Origin/Referer, +Cookie, полные браузерные) —
**все дают 403**, значит дело не в заголовках и не в Referer. `cmp403.py` на `dQw4w9WgXcQ`:
в url **`n` отсутствует** ⇒ **206 `bytes 0-1023/3449447`**; на 403-роликах в url **`n` есть**
(`itag=140`, `sig/lsig` подставлены, `pot` нет). Итог: 403 = **невыполненная n-трансформация**,
подтверждено на уровне одного и того же клиента (`ANDROID_VR` 1.60.19 + куки, `c=ANDROID_VR`).
Побочно: аргумент про poToken окончательно снят.
- Гейт «мигает»: тот же `ANDROID_VR`+куки на `jNQXAC9IVRw`/`9bZkp7q19f0` через минуту даёт
  `LOGIN_REQUIRED` (троттлинг/репутация IP) ⇒ в продукте нужен ретрай с паузой, а не одна попытка.
- yt-dlp напрямую с этим jar сейчас: `Sign in to confirm you're not a bot` даже при
  `player_client=web_embedded`/`default` + `--js-runtimes node` ⇒ у yt-dlp тоже нестабильно.
Идёт проба: даёт ли трансформация `n` 206, и можно ли решать `n` ЧИСТЫМ JS (без node), чтобы
гнать его в JS-движке Cobalt ⇒ тогда нативный филлер реален без ПК и без WebView.
**СТАТУС (18:5x): проба НЕ ДОКАЗАНА — упёрлись в бот-гейт по IP.** За 15 попыток свежий url с `n=`
не получен (`LOGIN_REQUIRED`), по 4 попытки на ролик. Причина — мы сами за час сделали ~150
player-запросов (матрица + пробы) ⇒ IP «нагрет». Побочно: дважды пришёл `OK` с url **без `n`**
(`3d02_HVUY7w`, `jNQXAC9IVRw`) — значит отсутствие `n` не уникально для `dQw4w9WgXcQ`.
В yt-dlp `2026.10.21` старых `_extract_n_function`/`_decrypt_nsig` больше нет (перешли на EJS).
⇒ Дальше: пауза по сетевым пробам (30–60+ мин), затем ОДИН аккуратный прогон (≤5 player-запросов,
пауза 10–15 с): url с `n` → решатель → GET → ждём 206. Пока пауза — делать код, который не
требует YouTube-запросов (чтение сессии из БД, Range-качалка, /meta_local).


### 1d. (25.10 18:3x) НАПРАВЛЕНИЕ ПРОДУКТА (решение пользователя) + замена мастера куки
- **Основной проект = serverless** (публикация): никакого своего сервера/ПК в рантайме, раздача
  через GitHub Releases/OTA. ПК-филлер допускается только как **отдельный личный билд/ветка**,
  в публичный рантайм не входит. Крайний вариант, если serverless не выйдет — **приложение-компаньон**.
- **Мастер-куки заменён (разрешено пользователем)**: `dev_server/yt_cookies.txt` ←
  `yt_cookies.new.txt` (482 835 B, SHA256 `7DF45A77…`), старый анонимный jar сохранён как
  `dev_server/yt_cookies.bak.2026-10-25-anon.txt` (478 768 B, SHA256 `CCEF72C1…`). Все в `.gitignore`.
- Проверка мастера «живьём» сразу после замены дала `playability=LOGIN_REQUIRED`/`UNPLAYABLE`,
  НО в этот момент по тому же IP работала фоновая матрица (десятки player-запросов) ⇒ результат
  считаем загрязнённым, повторять на «тихом» IP. Байты мастера побайтно = `.new`, а `.new` проверен
  tester'ом как живой (LOGGED_IN:true, accounts_list logged_in=1, yt_lang.en) ⇒ замена корректна.
- Урок для продукта: бот-гейт реагирует на частоту запросов с IP ⇒ в приложении нужны паузы,
  ретраи и «мягкая деградация» (не показывать «сервер не отдаёт ролик» после одной попытки).

### 1e. (25.10 18:4x) Хранилище сессии на ТВ: доступно мосту, но аккаунт НЕ залогинен
Проверено на ТВ (read-only, tester):
- APK `io.gh.reisxd.tizentube.cobalt` **DEBUGGABLE**, `run-as` работает, `userId=10246`,
  `dataDir=/data/user/0/io.gh.reisxd.tizentube.cobalt`; root/su нет и не нужен.
- Единственный cookie-стор — Chromium/Starboard:
  `app_content_shell/content_shell/Cookies` (SQLite, 24 576 B). `databases/` и `shared_prefs/` пусты.
- **Куки лежат ОТКРЫТЫМ текстом** (`value` заполнен, `encrypted_value` = 0 байт, нет `v10/v11`,
  Keystore не используется) ⇒ наш мост (тот же uid) может читать БД напрямую, без расшифровки.
- Но авторизации в этой БД НЕТ: 12 куки, все `*youtube.com`, только анонимные
  (`VISITOR_INFO1_LIVE`, `YSC`, `PREF`, `S`, `DEVICE_INFO`, `__Secure-YNID`, `YT_DERP`, `YT_TVFAS`…);
  `SID`/`SAPISID`/`APISID`/`__Secure-1PSID`/`LOGIN_INFO` — 0 строк.
  ⇒ **в Cobalt на ТВ YouTube НЕ залогинен** (вопреки прежнему предположению); в системе/Chrome — не считается.
Следствие для архитектуры: путь A2 (сессия с ТВ) реализуем — требуется ОДИН разовый вход через
код (`youtube.com/activate` / «Войти» в меню приложения), после чего куки появятся в этой же БД и
мост их прочитает. Путь A1 (уже залогинен) недоступен без этого шага.

## 3zv. (25.10) «Пропадает интерфейс плеера, все кнопки» — фикс + диагностика
Жалоба: «иногда в какой-то момент пропадает интерфейс плеера, все кнопки, помогает
перезапуск приложения». Лог `vot_ui_gone.log` (23:17–23:20) ошибок Cobalt не дал; за весь
ролик `_XXwZROjckI` не было ни `paint on`, ни `paint: node not found` (тик молчит, когда
состояние совпадает, — по логу причину не увидеть). Пока ТВ не трогаем (ждём команду).
Закоммичено `6400f72ff79` (+ `2d8e4215249` — `/temp/` в `.gitignore`), запушено в
`origin/fix-vot-runtime-injection` 25.10:
- **Причина №1 (главная гипотеза): перехват стрелок.** `votSliderKeys` гасил LEFT/RIGHT
  (`preventDefault`+`stopPropagation`), если `volKeyOf(document.activeElement)` совпал с
  «громкость перевода»/«оригинал при переводе». После закрытия нативной панели её DOM
  остаётся в дереве и продолжает держать `activeElement` ⇒ стрелки навсегда уходили в нашу
  ветку, клиент их не получал, ряд кнопок/прогресс не появлялся. Фикс: новый
  `nodeOnScreen(a)` (узел в документе, rect ≥4 px, сам узел и 3 предка без `display:none`/
  `visibility:hidden`/`opacity<.05`); если строка не видна — клавишу НЕ трогаем, в лог
  `vol slide ignored: row not visible kc=…` (≤12).
- **Причина №2 (страховка): невидимый полноэкранный слой.** `vot_ui.js`: `close()` получил
  страховочный `setTimeout(done, 400)` — если кадры `animRun` не дошли (rAF в Cobalt при
  видео), `#vot-ui-root` принудительно теряет `.vot-open`; `closeGen` (инкремент в `show()`
  и в `close()`) не даёт страховке погасить заново открытую панель.
- **Щит от повторной инъекции**: `window.__VOT_OVERLAY_MARK === MARK` → ранний `return`
  (иначе TizenTube, подгружая userScript повторно, плодил таймеры/MutationObserver/слушатели).
- **Сторож интерфейса** (диагностика, ≤120 строк): `uiSample()`/`uiWatch()` в тике 1200 мс
  раз в два тика, лог только при изменении:
  `ui rows=1 btn=4 lb=9 vis=1 432x72 our=1 panel=0 toast=0 af=body` — по `btn/vis/our/panel`
  видно, исчез ли ряд кнопок, скрыт ли он и не залип ли наш слой.
Проверено: `node --check` оба файла OK; содержимое в HEAD совпадает с проверенной рабочей копией
(`vot.js` 139 345 B, `vot_ui.js` 22 115 B); в `raw.githubusercontent.com/.../fix-vot-runtime-injection`
все маркеры на месте (`nodeOnScreen`, `uiWatch`, `__VOT_OVERLAY_MARK`, `gateReady`, `closeGen`).
На ТВ НЕ проверялось. Dev-сервер сейчас НЕ запущен — перед прогоном поднять
(`C:\Program Files\Python311\python.exe dev_server\serve_vot.py`).
Следующий шаг: по команде пользователя перезапустить приложение, довести до пропажи UI,
снять `logcat -d -s VotBridge` и смотреть строки `ui …` / `vol slide ignored`.

## 2. РАБОТАЕТ (проверено E2E многократно, последний 24.10 11:43)
Кэш Яндекса шардирован по полю 8 (`language`); лестница `status=6/0`: другой шард → ПК-филлер
(`kick` `first=true` перед upload, только `140/bestaudio[ext=m4a]`) → `status=2` → `status=1` →
`restart video`. Язык шарда берём от ТВ; tid не перезаписываем (шард = задача).

## 3. UI: что уже есть
- `dev_server/vot_ui.js` v0.2 — CSS (`adoptedStyleSheets` + fallback `style[nonce]`), стек панелей,
  свой focus-manager (capture keydown/keyup), тосты, prefs в `localStorage['vot-ui-prefs']`,
  строки `toggle`/`action`/`info`/`slider`/`choice`.
- `dev_server/vot.js` — `setupUI()`, `openTranslatePanel()` (10 пунктов), `applyVolume()`,
  `fetchMeta()` (через `/fill_status` моста), гейтинг `pcFill`/`otherShard`/`translate`/`skipLang`/`shard`,
  `manualFill()`, `checkFillStatus()`, `debugKeys()` (лог фокуса, `hit=1` = наша кнопка).
- `dev_server/serve_vot.py` — склейка `vot_ui.js + vot.js` по `/vot.js`, `/meta?videoId=` (yt-dlp,
  `META_CACHE`), `/fill`, `/fill_status` (отдаёт ещё `lang`/`title` + фоновая догрузка yt-dlp),
  `/config`, `/log`, `/ping`.
- **Панель проверена на ТВ**: F4 открывает, BACK закрывает, D-pad/ползунки/подсписки работают
  (`[VOT-UI] init ok adopted=1`).
- **Кнопка в баре плеера РАБОТАЕТ (24.10, подтверждено пользователем)**: кнопка 文A видна в ряду
  контролов, фокус на неё попадает (D-pad вправо), OK открывает нашу панель.
  Осталось: (а) вставка идёт в ДВА массива (`[…|SPEED] end` и `[PIP|PLAYBACK_SETTINGS] at 1`),
  поэтому на экране ДВЕ наши кнопки — дедуп внутри массива есть, между массивами нет, вставлять
  только в один ряд; (б) подпись сделать «Перевод (Яндекс)», чтобы отличать от прочих и чтобы
  `hit` в логе не путался.
- **Кнопка в плеере (проверено 24.10 11:53)**: `installPlayerButton()` нашёл `_yttv.bX`, обернул
  конструктор (`btn ctor wrapped key=bX`), патчил 2 метода, вставил кнопку в массивы `[SPEED]`/`[PIP]`
  — но в панели её НЕТ: неизвестный `TRANSPORT_CONTROLS_BUTTON_TYPE_VOT_TRANSLATE` рендерер
  выбрасывает. `resolveCommand` захукан (14 инстансов), `btn PRESSED` не было.
  Сейчас: тип = `…_PIP` (известный энум), дедуп по `customAction`; плюс надёжный путь —
  `popupInsert()` добавляет пункт «Перевод» в нативное меню шестерёнки (там TizenTube держит
  мини-плеер/шаринг/PiP), действие `VOT_PANEL_SHOW` ловится в `hookResolve`.
- `/meta` с ТВ принципиально недоступен (HTTPS-страница → `http://192.168.1.186` = mixed content).
  Язык оригинала теперь приходит в `/fill_status` (его мост проксирует как есть): ПК дописывает
  `lang`/`title` из `META_CACHE`, холодный кэш ~10 с.
- **Перевод нужен «с иностранного на русский»**: `skipLang` по умолчанию = `ru`
  (`prefs.v=2`, миграция сбрасывает застрявший `en` из тестов). Язык приходит асинхронно,
  поэтому `startTranslation` ждёт его 0.6 с + 2×1.5 с и стартует (`starting anyway`);
  поздно пришедший `ru` гасит перевод (`translate abort` + `state.skipLangBlock`);
  `origLang`/блокировка сбрасываются при смене ролика.

### 3a. ТЕКУЩЕЕ (24.10 14:5x): визуал кнопки «вкл»
Проблема была в том, что первую версию подсветки (`el.style.*` на узле, найденном по
`yt-button-container` + `textContent`) не находили: у рендерера подпись лежит в `aria-label`,
а не текстом. Сделано:
- поиск узла: `data-vot-toggle` → `[aria-label]`/`[title]` с «Перевод:» → XPath по тексту →
  старый перебор `yt-button-container`; от иконки поднимаемся `btnRoot()` к контейнеру кнопки
  (ограничение 130 px и ×2.6, чтобы не покрасить весь ряд);
- цвет теперь рисует CSS из `vot_ui.js`: `[data-vot-toggle][data-vot-on="1"]` = белый фон,
  тёмный `color/fill` на потомках, `transition` 0.18 с (как у субтитров); JS только ставит атрибуты;
- `state.wantOn` — кнопка белеет сразу по нажатию, не дожидаясь Яндекса; сброс при смене ролика;
- `isSelected`/`style` в `buttonRenderer` — попытка, чтобы родной рендерер сам рисовал «включено»;
- тик 1.5 с + `schedulePaint()` после инъекции: подсветка не расходится с состоянием;
- разовый `probeDom()` в лог (`paint on via … | up1..up3 | row=…`) — по нему видно, какой узел
  рисует кружок, если CSS всё ещё не даёт картинку.

### 3b. Визуал кнопки: работает (24.10 14:52, подтвердил пользователь)
`paint off via label ytlr-button-renderer 72x72` + `paint on via cache` — белый круг на «вкл» есть.
Структура (из probe): узел кнопки = `ytlr-button-renderer` 72×72, фон прозрачный; фон ряда даёт
родитель `div.clJQEe.Meo7z` (rgba(255,255,255,.1)); ряд — `ytlr-player-actions-container`; в ряду
4 кнопки по 72×72, наша — последняя (`len13RU`, `aria-label` длина 13 = «Перевод: выкл»).
Подпись лежит ТОЛЬКО в `aria-label`, текстом в DOM её нет ⇒ искать узел надо по `aria-label`.
`yt-button-container` в первые секунды отдаёт 0×0 — по нему красить нельзя.
Правки по просьбе пользователя (24.10 15:00): кружок на 5% меньше (`transform:scale(.95)`),
подпись всегда белая (`[data-vot-toggle]{color:#fff}`), тёмный цвет даётся только иконкам
(`data-vot-ic` ставит `markInside()`; если иконку не распознали — `data-vot-all` на всё).

### 3c. «Кружок уезжал на Комментарии» — причина найдена и убрана (24.10 15:1x)
- Причина: `findToggleNode()` отдавал узел из кэша по `data-vot-toggle`; YouTube переиспользует
  DOM-узлы кнопок, метка с ним «переезжала» на соседнюю кнопку (в UI белела «Комментарии»).
- Фикс: кэш убран (каждый paint ищет по `aria-label`), чужие `[data-vot-toggle]` снимаются в
  каждом paint, узлы 0×0 пропускаются, добавлены `verifyPaint()` (через 260 мс проверяем, что
  подпись на узле всё ещё наша) и `MutationObserver` на `aria-label/title` (мгновенный сброс при
  переиспользовании узла), в лог добавлено `lb=` (длина подписи).
- Прогон 24.10 15:08 (`zXaJFQRahYQ`): 6 строк `paint`, все `via label lb=13/14`, `paint wrong
  node` = 0, `recycle cleared` = 0, `mo ERR` = 0; `probe row=len69:144x28 len11 len9 len20
  *len13RU` — наша кнопка последняя, в её под-ряду 3 родных + наша (432 px = 144+3×72+72).
- Косметика осталась непроверенной пользователем: кружок на 5% меньше и белая подпись.
- Подтверждено пользователем (15:2x): «всё ок», подсветка на целевой кнопке.

### 3d. Кнопка = главный выключатель (24.10 15:4x, по просьбе пользователя)
Было: кнопка «выкл» действовала только на текущий ролик, на новом перевод стартовал сам.
Требование: при выключенной кнопке перевод не должен включаться сам при смене ролика.
Сделано (`dev_server/vot.js`): выключение кнопкой пишет `translate.enabled=false` (персист в
`localStorage`), поэтому новый ролик получает `translate skipped: disabled by button`; включение
кнопкой ставит `translate.enabled=true` и сразу переводит текущий ролик; пункт панели «Перевод
включён» и событие `translate.toggle` (F3/пульт) теперь идут через `toggleTranslate()` — тот же
выключатель, что и кнопка; текст статуса: «включить: кнопка 文A в баре (или F4)».
Проверено (прогоны 15:4x): F3 → `toggle: off` + возврат громкости; перезапуск приложения →
`translate skipped: disabled by button id=ubrAXXmFBKo`, `translate start`=0, `paint on`=0 — кнопка
осталась «выкл», автоперевода нет.
Дальше (со слов пользователя): в панели появятся два режима — «автоперевод всех при включённой
кнопке» и «перевод только этого ролика при нажатии кнопки». Сейчас реализован первый.

### 3e. «Кнопка гасла при смене ролика» (24.10 15:3x)
Было: `isTranslateOn()` возвращал true только когда звук реально играет/грузится, поэтому на новом
ролике (плеер+язык готовятся до ~4.5 с) кнопка показывала «выкл», хотя перевод включён.
Фикс (`dev_server/vot.js`):
- `isTranslateOn()` = «перевод разрешён для текущего ролика»: `prefs.translate.enabled` и нет
  `offForId`/`skipLangBlock`; состояние «вне watch-страницы» держим прежним через `state.paintOn`
  (иначе мигало при переходе между роликами);
- `schedulePaint()` сразу при `watch detected` — ряд кнопок перерисовывается, подсветка ставится
  за ~0.3–1.0 с, не дожидаясь тика 1200 мс.
Проверено (15:32, `epWYN5Uu-88` → `dQw4w9WgXcQ`): `paint off` = 0 за весь прогон, между `watch
detected` и `paint on` нового ролика «выкл» нет; `translate start` нового ролика через ~0.5 с,
`paint wrong node`=0, `mo ERR`=0.

### 3f. Пункт «Перевод» в меню настроек — РАБОТАЕТ (24.10 16:54, подтверждено пользователем)
Кнопка-дубль в ряду с шестерёнкой удалена, пункт есть ТОЛЬКО в корне меню настроек.
Как сделано (`dev_server/vot.js`):
- `hookMethod(inst, where, name, doPopup)` — хук `resolveCommand`, плюс попытки `dispatchCommand`
  / `executeCommand` (на этой сборке их на инстансах нет); флаг `__votHooked`, лог хуков ≤24 строк;
- `hookAllInstances()` вызывается ещё и периодически (`setInterval` 2 с, ~20 мин): диспетчер,
  который открывает корень `playback-settings`, создаётся позже старта;
- `popupInsert(cmd)` — ранний выход, если `cmd.openPopupAction.uniqueId !== 'playback-settings'`;
  список берём из явного пути `…overlayTwoPanelRenderer.actionPanel.overlayPanelRenderer.content.
  overlayPanelItemListRenderer.items` (`popupItemLists`, fallback `collectItemLists`), вставка
  `splice(2, 0, votPopupItem())` ДО вызова оригинала и повторно после; дедуп — `popupHasOurs`
  по нашему `VOT_ACTION`;
- логи: `popup item inserted n=9 [Качество / Субтитры / Перевод / Аудио / …]`.
Проверено логом 16:54 (`vot_g2.log`): `root=1`, в чужих попапах (`captions-unavailable`,
`quality-selector`) вставки нет; `btn PRESSED exec` → наша панель; `btn TOGGLE` → перевод.
**Защита подсветки**: пункт меню подписан «Перевод», как кнопка, поэтому `isToggleLabel()` теперь
требует двоеточие («Перевод: вкл/выкл»), а `inOverlay()` (с белым списком
`ytlr-player-actions-container`) отсекает узлы оверлеев/попапов — иначе кружок мог уехать на пункт
меню. Требует одного подтверждения (`paint on via label`) при следующем прогоне.

### 3g. Как это делают в TizenTube (по CDN-копии userScript)
Хук `instance.resolveCommand` по всем ключам `window._yttv`, признак корня —
`cmd.openPopupAction.uniqueId === 'playback-settings'`, тот же путь `…overlayPanelItemListRenderer.items`,
`splice` ДО вызова оригинала.

### 3j. Нативная панель РАБОТАЕТ (24.10 18:0x–18:2x, подтвердил пользователь)
Вложенная команда принята клиентом: пункт «Перевод Яндекс» открывает родную стопку плашек справа
с нативной анимацией, подуровни открываются, BACK закрывает. В логе НЕТ `popup inst= uid=vot-*` —
клиент исполняет `serviceEndpoint.commandExecutorCommand.commands` своим путём, минуя наши хуки
(поэтому `customAction` внутри пунктов всё равно доходит: `vot set vol.translate=…`).
Доработки по просьбе пользователя (18:2x, к проверке):
- у пункта в шестерёнке теперь `secondaryIcon=CHEVRON_RIGHT` (как у «Скорость»/«Пожалуйста»);
- переключатели в нашей панели рисуются как радио (`CHECK`/`RADIO_BUTTON_UNCHECKED`);
- `votItem` с полем `lv` добавляет второй командой перерисовку уровня (`votPanelCmd(lv,false)`),
  чтобы значение в списке обновлялось сразу после выбора (`votLevelItems(lv, rf)`, глубина ≤3);
- слайдер громкости: родного рендерера-слайдера в ТВ-клиенте НЕТ (проверено по кэшу
  `tv-player-es6.js`/kabuki: только `compactLinkRenderer`, `setting*`, `overlayPanel*`), поэтому
  `votSliderKeys()` в capture-фазе ловит LEFT/RIGHT, когда фокус на строке вида «40%»:
  шаг 10 %, сразу `uiSet('vol.translate')` + `applyVolume()` + тост «Громкость перевода: N%».

### 3i. Нативная панель через ВЛОЖЕННУЮ команду (24.10 18:xx, подтверждено)
Пересылка `openPopupAction` из JS клиентом игнорируется (`vot probe hit=0`), поэтому пункт
«Перевод Яндекс» теперь несёт панель В СВОЁМ `serviceEndpoint.commandExecutorCommand.commands[0]`
— тем же путём клиент открывает «Качество»/«Субтитры».
`dev_server/vot.js`: `votTpl` (команда корня из `popupInsert`) → `votCloneCmd(src, items, uid)` →
`votPanelCmd(lv)` → `votNavItem()`/`votPopupItem()`; уровни `vot-settings`/`vot-src`/`vot-shard`/
`vot-vol`/`vot-skip` собираются рекурсивно (глубина ≤2). Мёртвый путь удалён: `openVotPopup`,
`votProbe*`, `votDebug`, `openVotMenu`, `votHost`/`votSubHost`; `VOT_ACTION`/`VOT_NAV` остались
страховкой → DOM-панель. `votSet` больше не перерисовывает уровень (панель закрывается на выборе).
`domProbe` сканирует `getElementsByTagName('*')` + фильтр `ytlr-` (селектор `ytlr-*` в Cobalt бросает).

### 3h. Нативное меню «Перевод» (24.10 17:2x)
Отдельное DOM-окно заменяем на нативную многоуровневую панель. Формат снят дампом
(`popup#`): корень `uid=playback-settings` — полный payload лежит В САМОЙ команде
(`openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.
actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items`),
пункты-стрелки — `secondaryIcon=CHEVRON_RIGHT`, радио — `CHECK`/`RADIO_BUTTON_UNCHECKED`,
а `serviceEndpoint.openClientOverlayAction` несёт только `type` (контент тянет сервер,
свой тип зарегистрировать нельзя).
Реализовано в `dev_server/vot.js`:
- `votHost = {inst, fn, cmd}` — сохраняем диспетчер и шаблон корня при первом попапе
  `playback-settings` (в `hookMethod`);
- `votCloneCmd(src, items)` — копия звеньев пути с подменой `items`, метка `cmd.__votOwn`
  (свою панель `popupInsert` не патчит);
- уровни: `vot-settings` (Перевод вкл/выкл · Источник · Шард · Громкость · Язык-исключение ·
  Статус) → `vot-src`, `vot-shard`, `vot-vol`, `vot-skip`;
- действия: `VOT_NAV:<уровень>`, `VOT_SET:<ключ>:<значение>`, `VOT_FILL`, `VOT_FILLSTATUS`
  → общий `handleAction()`; после выбора уровень перерисовывается (галочка);
- `openVotMenu()` = нативная панель, при отсутствии шаблона — прежняя DOM-панель;
- диагностика: `vot probe <уровень> n=<узлов> hit=<найдено>` через 500 мс — рисует ли
  рендерер наши пункты. `node --check` и склейка `/vot.js` — OK, на ТВ не проверено.
**Итог прогона 17:22**: нативный путь не работает — `vot popup open vot-settings n=6`
есть, но `vot probe hit=0`: клиент не рендерит `openPopupAction`, собранный из JS
(диспетчер молча игнорирует). Поэтому `openVotMenu()` открывает DOM-панель, а нативная
панель осталась за префом `nativeMenu` (для опытов). Отладка: **F5** (`votDebug`) шлёт
диспетчеру исходную команду корня — если меню не появится, путь закрыт окончательно.
Пункт меню переименован в «Перевод Яндекс» (без двоеточия — `isToggleLabel` его не
принимает за кнопку, кружок на него не переезжает).
**UI-панель (по фото с ТВ)**: `left/top:50%` + `translate(-50%,-50%)` давало сдвиг
влево и обрезку края → центрирование переведено на flex у `#vot-ui-root.vot-open`;
анимация появления/закрытия — inline-стилями (`opacity` + `scale(.92→1)`, 220 мс,
`cubic-bezier(.2,0,0,1)`), т.к. CSS-keyframes в Cobalt не запускались; `.vot-list`
получил `max-height:600px;overflow-y:auto` (10 пунктов не влезали, фокус уводится
`scrollIntoView`).
**Итог 17:3x (со слов пользователя)**: пункт «Перевод Яндекс» есть, но панель
появляется без анимации (CSS-transition/keyframes в Cobalt не запускаются вообще).
Поэтому: (а) позиция панели — явные пиксели от `visualViewport` (`placePanel`,
цель хранится в `panelEl.__votL/__votT`); (б) анимация — покадровая из JS
(`animRun`: `requestAnimationFrame`, fallback `setTimeout(20мс)`), «выезд» слева
на ~170 px + `scale .94→1` + прозрачность, 230 мс; закрытие — 160 мс влево.
Диагностика в логе: `geom iw=… vv=… panel=…` и `anim in ok frames=N` —
по числу кадров видно, идёт ли перерисовка.
**Уточнение пользователя**: нативное меню — это НЕ окно по центру, а стопка плашек,
выезжающая справа из-за края; пункты перевода надо встроить в родное меню.
Ход (24.10 17:5x): добавлены зонды и попытка диспетчеризации в правильный инстанс:
- `popup inst=<id> uid=…` в хуке — видно, разные ли инстансы открывают корень и подпанели;
- `votSubHost` = инстанс, открывавший подпанель (`uid≠playback-settings`);
  `openVotPopup` шлёт команду сначала ему, потом корневому (`host=i`);
- `skel#N` — скелет `overlayTwoPanelRenderer` (есть ли подпанели внутри команды);
- `dom#N` — теги/классы/размеры нативных панелей в DOM (для копии вида);
- `openVotMenu` при `hit=0` через 460 мс откатывается на DOM-панель;
- F5 (`votDebug`) печатает `dbg orig … skel` и ре-диспатчит исходную команду
  через `votSubHost` — решающий тест «принимает ли клиент команды из JS».

## 3zz. Механики из расширения VOT 1.12.2 (24.10 20:15, ПРОГОН НА ТВ OK)
Цель: убрать лишние ожидания и штормы опросов, честно отказывать без лестницы.
- `Bridge.java` (`handleTranslate`): в лог `translate resp` добавлены `lang8=`/`allow=`/`retry=`,
  в JSON ответа — `lang` (поле 8), `allow` (11), `shouldRetry` (12). dex 40 236 B, APK установлен.
- `dev_server/vot.js`:
  - `handleResp`: поле 8 сразу в `state.origLang` + `maybeSkipNow` ДО запуска звука;
  - `status=0` + `allow===false` (и не после нашей загрузки звука) — терминальный отказ без
    ретрая/лестницы; `shouldRetry===false` снимает одноразовый повтор, `escalate` оставлен
    (другой шард = другая задача);
  - `status=6` + `allow===false` — только лог (флаг не трактуем: «нужен звук» лечится филлером);
  - `startTranslation`: ожидание языка 3 тика (4.5 с) → один 500 мс;
  - `poll()`: `NaN`/нет поля 5 больше не даёт `setTimeout(NaN)`; без подсказки — 3×3 с, потом
    8 с → 20 с (`POLL_NO_HINT/FAST_TRIES/SLOW/SLOW_MAX`), `state.polls` (сброс при смене ролика),
    в логе `poll in … rem=… n=…`.
- **Прогон 20:15 (3 ролика: `dQw4w9WgXcQ`, `jNQXAC9IVRw`, `9bZkp7q19f0`)**: новый dex работает
  (`allow=1` в ответах), `translate start` → `status=1` → `play` за ~0.3 с, `paint on` на каждом,
  `ERR`/`unhandled` = 0, `poll in` = 0 (кэш тёплый — ветка опроса живьём не проверена).
  **Важно**: поле 8 в ОТВЕТЕ не приходит (`lang8=-`), потому что мы всегда шлём поле 8 в запросе
  (`lang=en`) — Яндекс язык не детектит и не возвращает. Язык по-прежнему берём из `/fill_status`
  (`meta … lang=en`). Код на поле 8 остаётся как страховка (сработает, если поле придёт).
- Дальше: ревью + коммит.

## 3zy. Разбор ошибки перевода `DaeWIAqoEfI` (24.10 20:25, НЕ наш код)
Лог (`VotBridge`): ролик `DaeWIAqoEfI` (648 с, lang=en) не в кэше Яндекса → `status=6` (нужен звук) →
другой шард тоже пуст → ПК-филлер:
`fill failed state=err why=RuntimeError: yt-dlp: … --cookies for the authentication`
⇒ корень: **куки yt-dlp не авторизованы**, YouTube отвечает «Sign in to confirm you're not a bot».
- В `dev_server/yt_cookies.txt` для домена `.youtube.com` есть только `__Secure-3PSID/3PAPISID`,
  а `SID`/`SAPISID`/`LOGIN_INFO`/`__Secure-1PSID` = 0 (логина нет). Для `.google.com` логин есть,
  но yt-dlp читает домен `.youtube.com` ⇒ файл эквивалентен анонимному.
- Проверено (tester): `web_embedded`/`tv`/`android_vr`/`web_safari` — все дают бот-гейт; без куки
  ответ побайтно тот же. Контрольный `dQw4w9WgXcQ` с этими же куками качается (`itag=140`, 3.4 МБ)
  ⇒ конвейер рабочий, дело в конкретном ролике + отсутствии логина.
- Сделано (24.10 20:4x): `fill_audio.py` — fail-fast по маркерам `BOT_GATE`
  («Sign in to confirm you're not a bot», «cookies for the authentication»): после 2-го попадания
  `RuntimeError("нужен вход в YouTube: куки не авторизованы …")` вместо лестницы 4 клиентов.
  Замер: CLI 6.3 с, через `/fill` → `state=err` за 8.3 с (было ~40–60 с); хороший ролик 6.4 с.
- `vot.js` (`handleResp`, ветка ожидания филлера): при `state.pcFailed` опрос больше не
  прекращается молча — ставится явный статус «Перевод: сервер не отдаёт этот ролик /
  ПК-филлер не смог скачать звук» (раньше на экране висело старое «ПК готовит звук…»).
- **РЕШЕНО (24.10 20:44)**: пользователь закрыл Chrome → `yt-dlp --cookies-from-browser chrome`
  (с `--cookies <новый файл>`) дал **478 768 B** с живым логином: `SID`=153, `SAPISID`=34,
  `__Secure-1PSID`=153, `LOGIN_INFO`=319 для `.youtube.com`. Старый анонимный jar —
  `dev_server/yt_cookies.bak.txt` (в `.gitignore`, в коммит не идёт).
  `DaeWIAqoEfI` качается: `itag=140`, 10 491 796 B за 8.9–9.3 с.
- **Защита мастера куки**: `yt-dlp --cookies <файл>` ПЕРЕЗАПИСЫВАЕТ jar на выходе, а бот-гейт
  приходит с `Set-Cookie`, вычищающим сессию — именно так файл и «деградировал» до анонимного.
  `fill_audio.py`: `_cookie_args()` → `(args, how, tmp_jar)`, копия на прогон
  `%TEMP%\votfill\yt_cookies_run_<pid>_<rand6>.txt` (уникальная: параллельные `/fill` не
  топят друг друга), `download()` = `try: _download_with(...) / finally: os.remove(tmp_jar)`
  (`_download_with` — вынесенная лестница формат×клиент). Проверено: SHA256 мастера до/после
  совпал байт-в-байт, копия удалена.
- **Тот же риск в мета-пути** (нашёл tester): `serve_vot.py:_meta_worker` (фоновый yt-dlp для
  `lang`/`title`) отдавал МАСТЕР напрямую и тоже его перезаписывал. Теперь он берёт
  `fill_audio._cookie_args()` (пер-запуск копия) и удаляет её в `finally` (+`import os`).
  Проверено: после 3 прогонов мета-воркера SHA256 и mtime мастера не изменились.

## 3zx. ПК-филлер: `timeout waiting` ≠ провал (24.10 21:0x)
Замер (`fill_audio.py` без `--tid`, `DaeWIAqoEfI` 648 с): `kick first` tid=484055536 =
`kick before upload` tid=484055536 (шард стабилен), звук залит, но Яндекс >250 с держит
`status=3` (`rem≈175`) → `ok=false`, `error="timeout waiting for the translation"`.
`--max-wait` — только минимум: повторная заливка продлевает `deadline` на 90 с (150 → 250 с).
- `vot.js` (`handleResp`, ветка ожидания филлера): ответ `/fill_status` с `state=err` и текстом
  `/timeout waiting/i` больше НЕ считается провалом — `fill: server still synthesizing … -> keep
  polling`, `state.pcDeadline` продлевается на 120 с, опрос продолжается (звук у Яндекса уже есть,
  осталось дождаться синтеза). Настоящий провал (нет куки / yt-dlp) по-прежнему даёт явный статус.
- `langBase()`: сравнение языков режет регион (`ru-RU` = `ru`) в `maybeSkipNow` и в проверке
  `skipLang` — иначе русский ролик с тегом региона уезжал в перевод (замечание ревью).
- Ревью: blocker/major нет; закрыты minor (пер-запуск копия куки + удаление в `finally`,
  `langBase` и в первичной проверке `skip`).
- **Закоммичено 24.10 21:2x — `89f309220bf`** (ветка `fix-vot-runtime-injection`), 6 файлов.
- Осталось: прогон на ТВ длинного ролика (должен дойти до `status=1` после `fill timeout`).

## 3z. Громкость: два уровня (24.10, ГОТОВО и закоммичено)
Коммит `1d5697b20c2`.
Перевод играет нативный `MediaPlayer` в мосте ⇒ из JS его не приглушить: добавлен `POST /volume`
(`Bridge.java`: `sVol`, `setAudioVolume`, `mp.setVolume(sVol,sVol)` при создании плеера) — нужна
пересборка dex+APK моста. В `dev_server/vot.js`:
- `vot-vol` = две строки-ползунка: «Громкость перевода» (100 %) и «Оригинал при переводе» (0 %),
  `second: CHEVRON_LEFT`, подпись `N% · влево/вправо`; в корне — `votNavItem('Громкость', votVolText())`
  (`перевод N% · оригинал M%`), хелпер `volPct()` с клампом 0–100;
- `applyVolume()`: в мост `POST /volume {pct: vol.translate}` (только при изменении, `volSentTr`),
  видео = `state.active ? vol.original : 100` (без перевода уровень не трогаем), лог
  `vol tr=… orig=… active=… muted=… got=…`;
- `votSliderKeys()`: LEFT/RIGHT ловятся в capture, строка определяется по `aria-label`/тексту
  (`volKeyOf`: «громкость перевода» / «оригинал при переводе»), шаг 10, `preventDefault`,
  `applyVolume()` + `votPaintValue()` (правит цифру прямо в тексте/aria-label узла) + тост;
- `prefs.v=3`: `vol.translate=100`, `vol.original=0` (раньше оригинал 100 % перекрывал перевод);
- `VOT_VOLS` удалён; DOM-панель (`F4`) получила те же два слайдера.
`node --check` OK, склейка `/vot.js` отдаёт новый код (139 223 B). На ТВ не проверено.
**Прогон 24.10 18:55–18:56** (мост пересобран: `classes4.dex` 39 692 B, install Success):
`prefs migrated to v3`, `watch detected dQw4w9WgXcQ` → `translate start` → `status=1` → `play` →
`vol tr=100 orig=0 active=1 muted=1 got=0` (оригинал заглушён, это и нужно) → `audio volume 100%`
от моста (значит `POST /volume` работает). `vol ERR`=0. Ждём проверки с пульта.
**Подтверждено пользователем (24.10 19:0x)**: «работает все» — ползунки меняют звук перевода и
оригинала сразу, цифра в строке обновляется, значения переживают перезапуск меню, при выключенном
переводе уровень не меняется. Временная диагностика удалена (`dumpPopup`, `panelSkeleton`, `domProbe`,
`probeDom`, `debugKeys`, `escAscii`, мёртвые `closeTimer`/`votNavLog`/`menu.debug`), ревью пройдено
(0 blocker/major), смоук после чистки: `vol tr=100 orig=10 active=1` → `audio volume 100%`,
`paint on` на двух роликах подряд, `unhandled`=0, `vol ERR`=0.

## 3zw. Шкала ожидания + быстрый язык оригинала (24.10 22:0x, НА ТВ ПРОВЕРЕНО)
По просьбе пользователя: пауз нет (оригинал играет), вместо «~224с» — прогресс-шкала;
и русский ролик с готовым кэшем больше не должен заиграть переводом.
- `dev_server/vot.js`: в `ensureStatus()` текст вынесен в `#vot-status-text`, добавлены
  track/fill; `setProgress(prog)`/`barTick()` — покадровый JS-таймер 80 мс (CSS-анимации в
  Cobalt не идут): ширина = `t/(t+rem)` с кэпом 92 %, без `rem` — бегущий сегмент 26 %.
  `setStatus(text,color,prog)`; `prog` передан из `poll()` (`rem>0?rem:'wait'`), «ищу/скачиваю
  звук», «ПК готовит звук», «жду решения сервера», «повторяю запрос», «ищу в другом кэше».
- **Новый `dev_server/yt_lang.py`** — язык оригинала за 0.4–0.5 с: POST
  `/youtubei/v1/player` клиентом **WEB** + `Cookie` (мастер-jar, только чтение) +
  `Authorization: SAPISIDHASH <ts>_<sha1>`; язык = `defaultAudioTrackIndex` →
  `audioTracks[i].audioTrackId` (`ru`, `en-US.4`), фолбэк `captionTracks[0].languageCode`.
  Кэш в памяти 6 ч (ошибки 2 мин). Проверено на ПК: `3d02_HVUY7w`→ru (449 мс),
  `jVpn7jDNzZI`→en-US (466 мс), `dQw4w9WgXcQ`→en (406 мс).
  Почему так: Яндекс язык в ответе не отдаёт **никогда** (проверено: поле 8 пусто при
  `""`/`auto`/`en`; полей языка в ответе нет вообще), ANDROID_VR/IOS/ANDROID и голые куки
  упираются в бот-гейт (1/14 успехов), только `WEB`+`SAPISIDHASH` = 24/24 OK.
- `dev_server/serve_vot.py::_meta_worker`: сначала `yt_lang.detect()`, при успехе сразу
  возвращает `lang/duration/title` (0.4 с вместо 6–10 с yt-dlp), иначе — прежний yt-dlp.
  Мост/протокол не менялись: язык по-прежнему приходит в `/fill_status`.
- `dev_server/vot.js`: `gateReady(id,url,partial)` — если `skipLang` задан, а язык ещё
  неизвестен, готовый перевод НЕ играет до прихода языка (статус «готов, проверяю язык
  ролика…» + бегущая шкала), максимум `LANG_GATE_MS=6000`/`cfg.langGateMs`; при исключённом
  языке звук не стартует вовсе, при неизвестном по таймауту — `lang unknown -> start anyway`.
  Гейт снимается при смене ролика, `skipLangBlock`, выключении кнопкой. `META_GAPS`
  `[400,600,900,1500,2500,2500,2500,2500]` — первые опросы меты частые (язык к ~0.8 с).

**Прогон 24.10 21:56–22:02 (overlay 157 776 B, мост не пересобирался)**:
- ПК: `meta 3d02_HVUY7w fast lang=ru 506ms`, `meta jVpn7jDNzZI fast lang=en-US 533ms`;
  `/fill_status` первый раз отдаёт JSON без `lang` (фон), через 1.2 с — `"lang":"ru"`.
- **Русский `3d02_HVUY7w`**: `watch detected` → `meta lang=ru` **+125 мс** → `translate skip
  (late meta)` +131 мс; `translate req`/`resp`/`play` = **0**, `translate abort` = **0**.
  Ролик вообще не попадает в перевод (баг закрыт). Повторный прогон: +131 мс, так же.
- **Английский `dQw4w9WgXcQ`**: `resp status=1` → `lang gate wait … max=6000ms` → `meta lang=en`
  через 0.87 с → `play` → `lang gate: lang=en -> play`; gate→play **1.12 с**, watch→play 1.93 с,
  `vol tr=100 orig=10 active=1`, `audio volume 100%`, `lang unknown -> start anyway` = 0.
- **Шкала** (`DaeWIAqoEfI`, кэша нет): `status=6 -> pc fill` → `fill queued` → `resp status=2
  rem=171…144`, подпись «(~171с)» → «(~153с)», полоса **47 px → 88 px** (13 % → 26 %) за 20 с.
  Скриншоты `%TEMP%\opencode\vot_bar.png` / `vot_bar2.png`.
- Аномалии (не блокеры): `translate: source lang unknown, starting anyway` для иностранных
  роликов остаётся (запрос уходит за ~0.14 с до языка — звук всё равно держит гейт);
  `paint: node not found` один раз сразу после `watch detected`; `btn injected` дважды
  (дедуп только внутри массива — известное); `unhandled`/`ERR`/`abort` = 0.
- Заметка: `adb exec-out screencap > file` из PowerShell пишет UTF‑16 (битый PNG) — снимать
  через `cmd /c "… > file"`.
- Правки по ревью (minor): `yt_lang.py` — bool-guard для `defaultAudioTrackIndex` и точное
  совпадение домена куки (`youtube.com` / `*.youtube.com`, ведущая точка срезается);
  `vot.js` — `state.gate` сбрасывается в начале `stopAudio(true)` (до раннего return) и на
  `pageGone` (иначе отложенный запуск мог сработать после ухода со страницы);
  `META_GAPS` = 9 шагов (сумма 15.9 с);
  `serve_vot.py` — `import yt_lang` наверх в `try/except` (+`sys.path`), без него сервер
  поднимается и работает на yt-dlp.
- Смоук после правок 22:26 (overlay 157 960 B): ПК `meta 3d02_HVUY7w fast lang=ru 474ms`,
  `jVpn7jDNzZI en-US 501ms`, `yt_lang unavailable`/трейсбеков нет; ru-ролик — `translate skip
  (late meta)` + `meta lang=ru`, `play`/`abort` = 0; en `dQw4w9WgXcQ` — watch→meta 0.53 с,
  `play https` на 2.13 с, `audio volume 100%`; переключения вперёд/назад через BACK — перевод
  возвращается (`vol active=1`), `gate wait` живьём не воспроизвёлся (язык приходит раньше
  готовности перевода, это и есть цель); `unhandled`/`ERR`/`abort` = 0.
- Смоук 22:33 после переноса сброса гейта (overlay 158 088 B): пауза/снятие — `POST /pause` →
  `sync pause reason=paused(ev)` → `POST /resume` → звук продолжает играть (переигровки нет);
  BACK → `watch left -> stop`, `vol orig=100 active=0`; повторный вход без deep link —
  `play https` заново, `vol active=1`; ru-ролик — `meta lang=ru` +87 мс → `translate skip`,
  `play`/`abort`=0; `ERR`/`unhandled`=0 (кроме известного Cobalt `onerror Script error. @:` на
  старте приложения до первого ролика).
- **Закоммичено 40697a4ed9a** (ветка `fix-vot-runtime-injection`), 4 файла.

## 4. Клавиши (Android keycode → web keyCode)
`134`→`115` (F4, панель), `133`→`114` (F3, вкл/выкл перевода), `82`→`18` (MENU — тоже панель),
`23`→`13` (OK), `4`→`27` (BACK), `21/22/19/20`→`37/39/38/40`. `115`/`114` в `input keyevent` —
это CapsLock/F3, не использовать. Zylon даёт фокус только родным `ytlr-*`; наш `div[tabindex=0]`
получает `focus()`, но фокус отбирается за ~1.5 с ⇒ навигацию в своей панели ведём сами.

## 5. Ограничения среды
- `ytInitialPlayerResponse` на ТВ нет ⇒ язык оригинала только через `/meta` (yt-dlp, до 2 мин).
- `ytlr-player-container` = 9 узлов, родных кнопок в нём нет; Leanback DOM — light DOM.
- CSP: inline `style="…"` и новые `<style>` не работают; `el.style.*`, `adoptedStyleSheets`,
  дописывание в `style[nonce]` — работают.
- `logcat`-буфер переполняется за ~16 с ⇒ для зондов потоковая запись в файл.
- Bridge тянет `/vot.js` каждые 8 с; новый код применяется после перезапуска приложения.

## 6. Дальше
**Сделано 24.10 (коммит `1d5697b20c2`)**: нативная панель «Перевод Яндекс» в шестерёнке
(пункты вложены в команду корня `playback-settings`), стрелка `>` у пункта, радио-галочки,
панель «Громкость» = два ползунка (перевод / оригинал при переводе, шаг 10 %, значение
перерисовывается в строке), мост `POST /volume` (`sVol`), префы v3, диагностика удалена.
Осталось (по приоритету):
1. Микшер (одновременный оригинал+перевод) — сейчас это и есть «Оригинал при переводе» (уровень
   видео 0–100 при активном переводе); отдельного второго потока нет.
2. Два режима автоперевода: «все ролики при включённой кнопке» (реализовано) и «только этот ролик».
3. Техдолг: язык оригинала из поля 3 ответа Яндекса (вместо yt-dlp/`/fill_status`); `fill failed … --cookies` — ЗАКРЫТО (живые куки + fail-fast + защита мастера).
0. СДЕЛАНО (12:41–13:20): кнопка в баре → OK → панель (10 пунктов) → BACK без остановки видео;
   все пункты проверены живьём; язык оригинала приходит с ПК через `/fill_status`
   (`meta id=dQw4w9WgXcQ lang=en` за ~200 мс); `skipLang` E2E (`translate skipped: source lang=en
   matches skipLang`); ПК-филлер `status=6 -> pc fill -> 2 -> 1 -> play` за 44 с; ползунок
   перевода применяется (`vol pct=50 active=1 got=0.5`).
0b. СДЕЛАНО (13:23–13:47): `skipLang` по умолчанию `ru` (`prefs.v=2`), `startTranslation` ждёт язык
   тик 600 мс + 2×1500 мс и стартует (`starting anyway`), поздно пришедший `ru` гасит перевод
   (`translate abort`, `skipLangBlock`), отложенный `poll` после отмены не отправляется
   (`first=false` = 0). Живьём: тёплый `ru` (`3d02_HVUY7w`) — пропуск за **116 мс** без ожидания;
   холодный `ru` (`1EBYQr09KVg`) — `start` → abort через ~2 с, запросов после abort нет;
   `en` — `status=1`, `play`, `vol pct=50`. Тёплый старт `en` — **723 мс** (тик 600 мс).
0d. СДЕЛАНО (13:50–14:05) — правки по ревью + смоук: `typeof Reflect !== 'undefined'` в обёртке
   кнопки (ES6 в ES5-коде дал бы ReferenceError); честные логи `pcFill denied: pref off|cfg off|
   already tried`; `META_LOCK` в `serve_vot.py` (атомарная постановка в `META_PENDING`, он же для
   чтения/записи `META_CACHE`); retry `fetchMeta` при сетевой ошибке (с проверкой `state.curId`);
   инициализированы `state.origLang`/`state.uiStatus`; `fire('pref.…')` только при заданном `pref`;
   `handle_error` в сервере глушит `ConnectionResetError`/`BrokenPipe` (ТВ рвёт keep-alive).
   Смоук: `/ping` pong, 4 параллельных `/fill_status` — 4×200 без трейсбеков; `ru` `3d02_HVUY7w`
   → `translate skip (late meta)`, запросов нет; `en` `dQw4w9WgXcQ` → `status=1`, `play`, `vol pct`;
   `btn ctor ERR`/`unhandled` — нет (только известный `yttv stringify err`).
0c. Техдолг (убирает зависимость от yt-dlp): язык оригинала есть в ответе Яндекса (поле 3
   протокола), но мост его не отдаёт в JSON — нужна правка `Bridge.java` + пересборка dex.
1. Микшер (оригинал+перевод одновременно) — нужен второй поток (`/audio` → `<audio>`);
   вопрос пользователю: «оригинал» = громкость без перевода или одновременный микс.
2. СДЕЛАНО (16:54): пункт «Перевод» в КОРНЕ меню настроек (шестерёнка), вторая кнопка в баре
   удалена; кнопка в баре — главный выключатель, состояние переживает смену ролика.
2b. Ждёт подтверждения: после защиты `isToggleLabel`/`inOverlay` проверить, что подсветка кнопки
   по-прежнему ставится (`paint on via label`), а кружок НЕ появляется на пункте меню «Перевод».
3. Техдолг: корневой `vot.js` (v2, 449 строк) устарел — решить, удалять ли.
4. СДЕЛАНО (14:10): коммит `9f5afe8703e` — кнопка в баре + панель, `skipLang=ru` по умолчанию,
   язык через `/fill_status`, фиксы ревью, `vot_ui.js` в индексе.

## 7. Операционное
`status`: 1 готово, 2 синтез, 5 частичный, 6 нет звука → филлер, 0 провал. Dev-сервер:
`C:\Program Files\Python311\python.exe dev_server\serve_vot.py`, `http://127.0.0.1:8013/ping`.
Логи ТВ только `adb -s 192.168.1.100:5555 logcat -d -s VotBridge`. Секреты
`dev_server/yt_cookies.txt`, `vot_secret.json` — в `.gitignore`. Репо — sparse-checkout:
новые файлы вне cone — `git add --sparse`.

--- (���������� �� STATE.md 29.10, �� ��������� E2E) ---

# STATE — TizenTubeCobalt + Yandex VOT (29.10.2026)

## Цель
Живые голоса Яндекса (VOT) в TizenTubeCobalt **serverless** (API Яндекса в рантайме + статика GitHub/CDN).
Ветка `fix-vot-runtime-injection`, PR в `main` не делать. История — `STATE_ARCHIVE.md`.
Тест: **`YNDX-00091` (magritte, Android 11, armeabi-v7a) `adb 192.168.1.100:5555`**, пакет
`io.gh.reisxd.tizentube.cobalt` 2.0.3, activity `dev.cobalt.app.MainActivity`.
**SberBox 192.168.1.198 НЕ ТРОГАТЬ** до отдельной команды.

## ✅ Работает на ТВ (проверено ранее)
- Standalone: overlay из assets → `/ping` 200 → `/config` (`audioMode:"local"`, `pcFill:false`).
- Бутстрап `libchrobalt.so` = `v@b003` (перепрошивка не нужна).
- E2E полного трека через мост: `V4WmgqIC5WI` 20.3 МБ / 4 чанка, `l9kzZXeO_bc` 63 МБ / 12 чанков
  (49 с) → `status=2` → `status=1`/`5` → `play`; видео не ускорялось и не вставало на паузу.

## 🔴 Активная проблема: InnerTube деградировал
29.10 ~00:05 все клиенты (`VISIONOS/VR/ANDROID/IOS/WEB`) отвечают `LOGIN_REQUIRED`
(«confirm you're not a bot») — мост не получает вообще никакого `videoplayback`-URL.
Ранее (23:47) ANDROID был `OK`, но отдавал 403 на `Range`. Отсюда решение: **URL берём
у самого плеера страницы** (`window.__votAudioSrc()` из `vot_net.js`, ловит XHR/fetch на
`videoplayback`, чистит `range`/`rn`), мост пробует его первым (`srcUrl/srcItag/srcClen/srcUa`).

## Сделано в этой итерации (не закоммичено)
- **Прогресс по скачанным байтам**: `asrcProgress()` + `RangeProgress` в `rangeGet`;
  `/audiosrc/status` отдаёт `phase/part/chunk/chunks/bytes/total/itag/client/ms`.
  Страница рисует «ищу аудиопоток…» → «качаю N%» → «отправляю N%» (`SRC_POLL_MS=700`).
- **Прогрев при старте моста**: тред `vot-warm` → `YandexClient.ensureSession()` +
  `PoToken.get(ctx,"")`; в логе `warm session ms=`, `warm pot ms=`. Замер холодного старта
  показал `session+pot = 7660 мс` (из них сам player pot 54 мс) — это и был «0 % на старте».
- **Порядок клиентов** `VISIONOS, VR, ANDROID, IOS, WEB`, 403 не ретраится.
- **Обход 403 через страницу** (Vox-подобный путь): если ни один клиент не дал скачиваемый URL,
  мост публикует `state:"need_page"` + `url/clen/chunks`, страница сама тянет части своим XHR
  (`Range: bytes=…`, `responseType=arraybuffer`) и постит их в `/audiosrc/raw?part=i`
  (binарный body), а мост заливает в Яндекс (`uploadChunkAudio`). Лимит body поднят до 12 МБ
  (было 4 МБ — 5.3 МБ часть молча терялась как «empty part»).
- `javac` (--release 8) и `node --check` для `vot.js`/`vot_net.js` проходят.
- **`visitorData` берём у страницы** (`window.__votVisitorData()` → `ytcfg.get('VISITOR_DATA')`),
  мост минтит poToken под него (`PoToken.getWithVisitor`): гейт `LOGIN_REQUIRED` привязан
  к visitor id, а у плеера он рабочий. Генератор BotGuard переиспользуется (только новый
  streaming-токен, ~50 мс), так что прогрев не теряется.
- **Важно:** плеер на ТВ теперь на **SABR** — его `videoplayback`-URL идёт без `itag`/`clen`
  (`c=TVHTML5`, `rn=`), как обычный GET не годится. Поэтому ловля URL у страницы — резерв,
  основной путь снова InnerTube, но с visitor id страницы.

## 🔧 Найдено 29.10: сломанный парсер protobuf
`Sabr.readVarint` был UMP-форматом (префиксные ведущие единицы), а им читали и
**protobuf** внутри частей → все дампы/поля (clen, itag из MEDIA_HEADER, `sabr_error`)
парсились мусором. Разделено: `umpVarint` (только заголовки частей) + `readVarint`
(base-128, protobuf). Добавлен `Sabr.fieldInfo()` и маршрут `GET /sabrbody`
(дамп тела плеера vs нашего + сравнение поля 5 ustreamer config).

## 🔴 Найден баг чтения: `readN` не усекал буфер
`Bridge.readN` возвращал массив целиком, даже если поток кончился раньше → ответ
`sabr.malformed_config` (31 Б) выглядел как 768 КиБ нулей, и парсер отчитывался
`parts={0=393201, 44=1}`. Теперь возвращается `Arrays.copyOf(b, off)`.
Следствия: реальные длины ответов, `parts`, `media`, `err` в `/sabrmix`, `/sabrreplay`.
Плюс `handleSabrReq` больше не теряет тело: пустой POST не перетирает последний
непустой захват (было `pageLen=1725` → через секунду `pageLen=0`).

## 🧪 Новый диагностический набор
- `Sabr.cmp/f/fieldBytes/drop`, `mix` переписан (повторяемые поля: все вхождения
  целевого поля из `other`, дубликаты в `base` выбрасываются).
- `GET /sabrbody` → `ucfgVsBody = Sabr.cmp(поле5 тела плеера, ucfg из SABRCFG)`:
  отвечает, совпадает ли конфиг в запросе плеера с тем, что отдал player-response.
- `GET /sabrmix` — лестница от **тела плеера** (контроль) к минимуму:
  `page`, `page+our4`, `page-sel140`, `+pa`, `+ctx`, `+abr`, `page-sel140-min`,
  `our`, `our+page5`, `our+page5+ctx`; в строке `code/len/media/itag/parts/err/hex`.
  Ключевые строки: первая, что даёт `itag=140` с медиа; и `our+page5` — если работает,
  достаточно подставить поле 5 из тела плеера (наш энкодер в порядке).

## ✅ 29.10 ~02:00 — ПРИЧИНА НАЙДЕНА: поле 5 (ustreamer config)
Лестница `/sabrmix` на живом ролике (10 строк):

| строка | media | itag | результат |
|---|---|---|---|
| `page` (тело плеера) | 262144 | 401 | ок |
| `page+our4` | 262144 | 401 | ок (поле 4 безвредно) |
| `page-sel140` | 263963 | 251 | ок (сервер дал 251, не 140) |
| `page-sel140+pa` | 0 | — | `sabr.no_audio_selected action=3` |
| `page-sel140-min` | 163102 | **140** | ок, segs=1 |
| `our` | 0 | — | `sabr.malformed_config action=2 status=0 type=12` |
| **`our+page5`** | **163102** | **140** | **ок, segs=1** |
| `our+page5+ctx` | 163102 | 140 | ок |

Вывод: наш энкодер тела **корректен**, ломает только **поле 5**. `ucfgVsBody`:
`a=1247 b=1271 diffAt=709` — `videoPlaybackUstreamerConfig` из player-response
(1271 Б) ≠ поле 5 из самого запроса плеера (1247 Б), расходятся с байта 709,
наш вариант на 24 Б длиннее и хвост — ASCII (`iaumtNcbn…`). Поле 19 (ctx) не нужно.

Реализовано: `sSabrUcfg` — байты поля 5 из захваченного тела плеера (`POST /sabrreq`);
`sabrParamsFromCfg` и `/sabrtest?page=1` берут конфиг оттуда (`sabrUcfgB64()`),
с фолбэком на `ucfg` из SABRCFG. Проверяется `/sabrtest?page=1`: ждём `ok=1`,
`bytes≈3449447`, `segs>0`, `eot=1`.

## ✅ 29.10 ~02:10 — SABR качает ЦЕЛИКОМ (поле 5 + wire-URL)
`/sabrtest?page=1` на живом ролике: `ok:1, bytes=3470846, media=3470846, segs=22, posts=22,
endMs=213090` (= полная длительность), `ms=3137`, `eot=0` (цикл выходит по
`bytes>=expectedLength` до EOT-маркера — не ошибка), `err` пуст.
Рабочая комбинация: **wire-URL из захваченного POST плеера** (`sSabrReq.url`, с
`alr/cpn/cver/rn/spc`) + **поле 5 из того же тела** (`sSabrUcfg`, 1246 Б).
`serverAbrStreamingUrl` из `SABRCFG` без pot → `403`.
Строки лога: `sabr post N rn=N t=<ms> bytes=<n> segs=<n> resp=<n> parts={…}`.

## 🔄 29.10 ~03:00 — page-SABR переведён на двухфазную схему (не проверено E2E)
Почему: `clen` из конфига страницы **протухает** (одинаков для разных роликов),
а Яндексу нужен **точный** размер в `fileId.fileSize` и точное число частей в финальной.
Поэтому: `SabrStage` пишет трек в `getCacheDir()/vot_asrc.bin` (download, `est=16кБ/с×dur`),
затем `uploadStaged()` льёт части по 5 295 308 Б из файла с реальным размером.
`sp.expectedLength=0`, `sp.maxPosts=900` (стоп по `endTimeMs`/`eot`).
`durSec` проброшен: `POST /audiosrc {duration}` → `audioSourceJob(..., durSec)`.
Добавлен `mp4Head(file)` → в логе `boxes=ftyp/…,moov/…,moof/…` (нет `moov` = Яндекс
скажет «нет речи», это и было в прогонах с `status 2 → 0`).
`javac` OK, `node --check` OK; APK ещё не собран.

## ✅/⚠️ 29.10 ~03:05 — E2E двухфазного page-SABR: загрузка прошла, перевод НЕ заиграл
`9bZkp7q19f0` (status=6): `staged=4108040`, `boxes=ftyp/24,moov/608,sidx/344,moof/1816,mdat/159980,`
**`ftyp/24,moov/608,sidx/344`** — init-сегмент повторился в середине файла! Загружено 1/1 частью,
`done bytes=4108040 ms=7079`, Яндекс: `status=2` ×3 → `status=0` «Не удается перевести видео»,
`lang8=ja` (на корейском треке) — т.е. звук декодировался, но это мусор.
**Исправлено (не проверено):** `Sabr.Result.inited` — повторный init того же itag больше не
пишется в sink (`dupInit=` в `summary()`); `initSegs`/`dupInitSegs` в логе. `mp4Head` до 24 боксов.
Новый маршрут `GET /sabrfile` → `{size,boxes,b64}` — вытянуть стейдженный трек на ПК и проверить
`ffprobe` (`C:\ffmpeg\bin\ffprobe.exe`), не гадая по статусам Яндекса.
`javac` OK; APK НЕ собран.

## 🔧 29.10 ~03:30 — цикл SABR не останавливался: перекачал трек 18×
`YQHsXMglC9A` (dur 367 с): `inits=1 dupInit=899` (фикс init работает), но `posts=900` (= упёрлись
в `maxPosts`), `bytes=109737678` при реальном треке **5 938 627 Б** — сервер после последнего
сегмента **начинает стрим заново с нуля**, а `endTimeMs` растёт вместе с `playerTimeMs`,
поэтому условие `playerTimeMs >= endTimeMs` недостижимо. Файл внутри валиден: `ffprobe` →
`aac/44100/2ch/127626`, `duration=366.898` ✓, декодирование без ошибок; первые 5 938 627 Б —
самостоятельный корректный трек. Заливка упала на `chunk 5/21` c `HTTP 504`.
**Исправлено (не проверено):** `Params.expectedEndMs` + стоп, когда медиа покрывает длительность
(`endTimeMs >= durSec*1000-500`); байтовый потолок `expectedLength = durSec*20000` (20 кБ/с);
детектор повтора (новые байты без нового диапазона → стоп после 3 постов, `err=replay at …`).
`/sabrfile?from=&max=` (по умолчанию 4 МБ, раньше OOM на 109 МБ).
`javac` OK; APK НЕ собран.

## 🔧 29.10 ~04:00 — page-sabr стартовал на конфиге от другого ролика
На `iG9CE55wbtY` (1203 с, первый `status=6` на живом ролике с речью) прогон ушёл в
`sabr.malformed_config action=2 status=0 type=6`, `bytes=0`, `posts=3`, `resp=31` ×3:
`sSabrUcfg`/`sSabrReq` были от предыдущего ролика (`ustreamer=1912`, а рабочий 1246–1592),
проверялся только `SABRCFG.vid`. Плюс `playerTimeMs >= endTimeMs` давало ложный стоп после 1 поста.
**Исправлено (не проверено):**
- `pageSabrUsable(videoId)` — пара «wire url + поле 5» должна принадлежать текущему ролику
  (`SABRCFG.vid` и `sSabrUcfgVid`); неизвестный id допустим, чужой — нет.
- `audioSourceJob` ждёт свежую пару до 12 с (`audiosrc page-sabr wait …` / `wait done ok=`),
  при отсутствии — `lastErr="page-sabr: no fresh player config"`, без фолбэка на `SABRCFG.ucfg`.
- `Sabr.run`: медиа поста копится в `Buf` и пишется в файл только если двигает таймлайн вперёд
  (`postEndMs > prevEnd`), иначе `dropped=`; 2 повтора подряд → `replayStop=1`.
- `SabrStage` чистит `vot_asrc.bin` в конструкторе (остатки прошлого прогона не считаются `staged`).
- Страница: при `state=error` до 3 ретраев `POST /audiosrc` с паузой 5 с (`audiosrc ERR … retry N/3`).
`javac` OK, `node --check` OK; APK НЕ собран.

## 🔴 29.10 ~04:10 — page-SABR скачивал ровно 1 сегмент (163 КБ из 5.7 МБ)
E2E на `8S0FDjFBj8o` (356 с) и контроль на `5MuIMqhT8DM` (1158 с): оба раза
`posts=1 endMs=9985 staged=163015` при ожидании 5.7 МБ / 18.5 МБ. Файл формально валиден
(`ffprobe`: `aac/44100/2ch/128k`, `duration=355.54/1158.28` — длительность берётся из контейнера),
`ffmpeg -f null -` без ошибок, но медиа в нём ~10 с → Яндекс `status=0`.
Причина: `P_FORMAT_INIT` (тип 42) несёт длительность **всего** трека (`m.num(3,0)`), и моё
стоп-условие `endTimeMs >= expectedEndMs-500` срабатывало на первом же посте.
**Исправлено (не проверено):** стоп считается по `prevEnd` — реально дописанному таймлайну
(`prevEnd >= expectedEndMs-500`), `P_FORMAT_INIT` больше не влияет на стоп, а только пишется в
`declMs=` для лога; `P_MEDIA_END` учитывает только не-init заголовки.
Плюс `__votAudioSrc()` теперь отдаёт url только для текущего ролика (`vid`), страница не
подсовывает мосту url возрастом 164 с от прошлого видео.
Проверено, что ретраи страницы работают: `audiosrc ERR … retry 1/3`, `retry 2/3`.
`javac` OK, `node --check` OK; APK НЕ собран.

## 🔴 29.10 ~04:25 — SABR отказывает на автодуб-дорожке (`xtags=acont=dubbed-auto:lang=ar`)
Прогон на трёх свежих `status=6` (`hPV-Ql_KGzM` 4199 с, `DLP0OqKhfPk` 1539 с, `rtrdroYs67A` 4014 с):
`page-sabr start … ustreamer=9032 urlLen=966` → `posts=3 bytes=0 segs=0 resp=170 parts={35=1,46=1,47=1}`
→ `err=no progress at 0ms` (новый guard отработал: 3 поста без байт, а не 900 постов / 109 МБ).
Ответ сервера — только `NEXT_REQUEST_POLICY` (35) + 46/47, ни `MEDIA`, ни ошибки. InnerTube
(ANDROID) на том же ролике отдаёт URL, но `403`, page-relay тоже `403 len=0/5295308`.
**Причина (гипотеза, от tester):** во всех захваченных URL `xtags=acont%3Ddubbed-auto%3Alang%3Dar` —
плеер ТВ выбрал автодублированную арабскую дорожку, и SABR её не отдаёт.
**Изменено (не проверено):**
- `sabrParamsFromCfg`: если `xtags` содержит `dubbed` → `xtags=""`, `lmt=0` (просим оригинальную
  дорожку; Яндексу нужен оригинальный голос).
- `/sabrtest?page=1&xtags=none|<value>` — A/B-переключатель трека (+ `xtags` в ответе).
- Логи: `sabr req itag= xt= lmt= seq=` (1-й пост) и `hex=` первых 240 Б «пустого» ответа;
  в `page-sabr start` добавлены `xt=` (что просим) и `cfgXt=` (что выбрал плеер).
`javac` OK; APK НЕ собран.

## 🔬 29.10 ~04:35 — разобран пустой ответ: сервер требует reload player-response
Расшифрован `hex=` (170 Б, одинаков на всех роликах): три части в порядке **47 → 46 → 35**.
- `47 PLAYBACK_START_POLICY` (10 Б): `0a0310b009120310f02e` (1200 / 6128).
- `46 RELOAD_PLAYER_RESPONSE` (138 Б): `field1.field1.token` = base64-proto из 132 симв.;
  внутри — `videoId`, постоянный токен `ywVb/oOP23MC8FMB18g92ntL55QdWA==` и 37 Б, меняющихся
  на каждом посте. По протоколу (комментарий в форке, `SabrStream.java:417-429`) клиент должен
  перезапросить `/youtubei/v1/player` с `playbackContext.reloadPlaybackContext.reloadPlaybackParams.token`.
  Форк этого не делает вообще (создаёт `RefreshPlayerResponseSabrPart` и выбрасывает).
- `35 NEXT_REQUEST_POLICY` (15 Б): `08987510987518e0d40320d00f3a00` — тайминги + **пустой
  `playback_cookie`**: сессию он нашей не считает.
Вывод: дело не в xtags/dubbed (A/B `xtags=none` дал тот же ответ) и не в URL. Наше тело не
похоже на тело плеера: у плеера есть `streamer_context` с `po_token`/`sabr_contexts`/capabilities
и `buffered_ranges`, у нас — только `client_info`+`po_token`.

**Сделано (не проверено):** `Sabr.replayBody(tpl, playerTimeMs)` + `Params.bodyTpl` — тело плеера
переигрывается байт-в-байт, правится только `client_abr_state.player_time_ms` (1.28) и поле 4.
Маршрут `GET /sabrtest?raw=1` берёт тело из последнего `POST /sabrreq` и отдаёт в ответе
`tplLen/ourLen/tplFields/ourFields/tplSc/ourSc` — прямое сравнение тел.
`javac` OK; APK НЕ собран.

## ✅ 29.10 ~04:45 — РАБОТАЕТ: replay тела плеера без buffered_ranges даёт медиа
`GET /sabrtest?page=1&raw=2` на `DLP0OqKhfPk` (1539 с): **`ok=1, bytes=7 488 968, media=20 157 709,
segs=54, posts=60, endMs=526541, firstMs=433`**, `parts={35,52,20=158,53,21=707,22=158,47}`
(т.е. реальные `MEDIA_HEADER`/`MEDIA`/`MEDIA_END`). `raw=1` (тело как есть, с полем 3) — **0 байт**,
`resp=187`, `parts={35,52,53,47}`. Итог: тело плеера + **вырезанные `buffered_ranges`** = рабочий
запрос; именно поле 3 сообщало серверу «эти диапазоны у меня уже есть».
`raw=2` воспроизводится (повтор через 30 с дал те же цифры).
Стоп на 526 с / 7.5 МБ: посты шли каждые ~90 мс, игнорируя `NEXT_REQUEST_POLICY` — сервер начал
отдавать повторы (`err=replay at 526541ms`, `resp=183` policy-only). Сервер присылает в части 35
тайминги `d=` (мс) — их надо соблюдать.

**Сделано (не проверено E2E):**
- `Sabr.replayBody(tpl, time, stripBuffered)` + `Params.bodyTpl/bodyStrip`; в replay-режиме
  `itag` не фильтруется (берём тот, что даёт сервер), `stuckLimit=20`, `replayLimit=4`.
- `Sabr.parse`: часть 35 разбирается в `nextDelayMs`/`lastDelayMs`, логи `d=`; `run()` ждёт
  `min(d, 5 с)` после пустого поста и повторяет (пейсинг по требованию сервера).
- **Production**: `audioSourceJob` (page-sabr) теперь берёт `capturedSabrBody(videoId)` →
  `bodyTpl` + `bodyStrip=true`, `itag=0`, `expectedLength=0`; в логе `tpl=/strip=`.
- `capturedSabrBody()` — тело только для текущего ролика (иначе null).
`javac` OK; APK НЕ собран.

## 🔧 29.10 ~05:05 — init-сегмент берём у плеера (MSE), флаг `aac`
`SabrStage` теперь пишется с init-сегментом: страница на **первом `appendBuffer`
аудио-SourceBuffer** постит эти байты в `POST /mseinit?vid=&mime=` (raw body), мост хранит
`sMseInit/sMseInitVid/sMseInitMime`, в `audioSourceJob` перед `Sabr.run` вызывается
`stage.init(mseInitFor(videoId))` (init только для текущего ролика). В логе `mseinit len=… head=…`
и в `page-sabr start` добавлены `init=`/`mime=`.
- Причина: SABR отдаёт сессии, которая уже играла, **только media-фрагменты** (`moov`/WebM header
  ушёл плееру раньше) → файл не контейнер (`inits=0`), Яндекс `status=0` «Видео слишком длинное».
- A/B-флаг AAC: `POST /config {"aac":true}` → `/config.aac` → страница при `CAP_ON||AAC_ON`
  включает `patchCodecs` (отказ `audio/webm|opus`). Цель — itag 140 вместо 251.
`javac` OK, `node --check` OK; APK не собран.

## ✅ 29.10 ~05:20 — AAC-путь даёт валидный mp4: itag 140, 0 ошибок декодирования
A/B на `hPV-Ql_KGzM` (4199 с) с `POST /config {"aac":true}`: `mseinit len=723
mime=audio/mp4; codecs="mp4a.40.2" head=0000001866747970` → SABR отдал **itag 140**,
стейдж **86 040 500 Б** (`boxes=ftyp/24,moov/699,moof/1816,mdat/160068,…`), `ffprobe`:
`aac/44100/2ch/duration=4198.655`, `ffmpeg -f null -`: **пусто** (ошибок нет).
Контроль без флага (`DLP0OqKhfPk`): `mseinit len=266 mime=audio/webm; codecs="opus"`, itag 251,
matroska/webm 29 737 993 Б, 25 000 ошибок `non monotonically increasing dts` → opus-склейка
не годится (сервер отдаёт перекрывающиеся фрагменты в другом порядке).
Итог: **init из MSE обязателен** (без него контейнера нет), **AAC обязателен** (opus-склейка битая).
`aac` теперь по умолчанию `true`; потолок байт поднят до `dur*24кБ` (itag 140 ≈ 20.5 кБ/с).
`javac` OK.

## Следующий шаг
1. Собрать APK, на свежем ролике (лучше с речью: TED/лекция) получить `status=6`.
2. Ждём `audiosrc page-sabr … staged=` ≈ `dur*16кБ` (не ×18), `audiosrc done client=page-sabr`.
   `ffprobe -v error -show_format -show_streams` + `ffmpeg -v error -i f.m4a -f null -`
   (ошибки декодирования = склейка SABR неверна). Ждём `aac`, 44.1/48 кГц, duration ≈ длительности ролика.
3. Если файл валиден и без ошибок декодирования, а Яндекс всё равно `status=0` — сравнить с эталоном:
   скачать тот же трек itag=140 через `rangeGet` (пока InnerTube отдаёт URL) и сравнить размер/сигнатуру,
   а также сверить `fileId.fileSize`/`parts` с тем, что отправляет браузерное расширение.
4. Ревью `reviewer` и коммит в `fix-vot-runtime-injection`.

## Грабли
- `am force-stop`/`kill` запрещены; install APK убивает процесс.
- `am start … -f 0x10008000` при живом приложении убивает surface → чёрный экран (только холодный старт).
- `adb forward tcp:18114 tcp:8013`; старый `18014` принадлежит `.198` — не трогать.
- Логи только `adb logcat -v time -s VotBridge:V`.
- `Bridge.java` с BOM (`utf-8-sig`); APK `tt203_bridge.apk`; `assets/vot.js` = `vot_ui.js + vot.js + vot_net.js`.

## Состояние гита
`5a03c018ba4` (serverless) + текущие правки (прогресс, warmUp, need_page, /audiosrc/raw) — не закоммичено.
