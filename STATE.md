# STATE — TizenTubeCobalt + Yandex VOT (24.10.2026)

## 1. Цель
Живые голоса Яндекса в TizenTubeCobalt на Samsung TV (`adb -s 192.168.1.100:5555`,
`io.gh.reisxd.tizentube.cobalt`, активити `…/dev.cobalt.app.MainActivity`): быстрый старт,
без отказов и заикания. UI — только JS-оверлей (без пересборки APK).

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
2. Мелочи кнопки (когда разрешит пользователь): оставить одну кнопку (один ряд), подпись
   «Перевод (Яндекс)».
3. Техдолг: корневой `vot.js` (v2, 449 строк) устарел — решить, удалять ли.
4. СДЕЛАНО (14:10): коммит `ae419c0` — кнопка в баре + панель, `skipLang=ru` по умолчанию,
   язык через `/fill_status`, фиксы ревью, `vot_ui.js` в индексе.

## 7. Операционное
`status`: 1 готово, 2 синтез, 5 частичный, 6 нет звука → филлер, 0 провал. Dev-сервер:
`C:\Program Files\Python311\python.exe dev_server\serve_vot.py`, `http://127.0.0.1:8013/ping`.
Логи ТВ только `adb -s 192.168.1.100:5555 logcat -d -s VotBridge`. Секреты
`dev_server/yt_cookies.txt`, `vot_secret.json` — в `.gitignore`. Репо — sparse-checkout:
новые файлы вне cone — `git add --sparse`.
