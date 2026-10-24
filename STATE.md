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
2. СДЕЛАНО (16:54): пункт «Перевод» в КОРНЕ меню настроек (шестерёнка), вторая кнопка в баре
   удалена; кнопка в баре — главный выключатель, состояние переживает смену ролика.
2b. Ждёт подтверждения: после защиты `isToggleLabel`/`inOverlay` проверить, что подсветка кнопки
   по-прежнему ставится (`paint on via label`), а кружок НЕ появляется на пункте меню «Перевод».
3. Техдолг: корневой `vot.js` (v2, 449 строк) устарел — решить, удалять ли.
4. СДЕЛАНО (14:10): коммит `ae419c0` — кнопка в баре + панель, `skipLang=ru` по умолчанию,
   язык через `/fill_status`, фиксы ревью, `vot_ui.js` в индексе.

## 7. Операционное
`status`: 1 готово, 2 синтез, 5 частичный, 6 нет звука → филлер, 0 провал. Dev-сервер:
`C:\Program Files\Python311\python.exe dev_server\serve_vot.py`, `http://127.0.0.1:8013/ping`.
Логи ТВ только `adb -s 192.168.1.100:5555 logcat -d -s VotBridge`. Секреты
`dev_server/yt_cookies.txt`, `vot_secret.json` — в `.gitignore`. Репо — sparse-checkout:
новые файлы вне cone — `git add --sparse`.
