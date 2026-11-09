# STATE — serverless VOT (06.11.2026)

## 06.11 (вечер): HOLD на серии поздних ретраев (русский ролик, 9 мин)
- Симптом (`P541-Kmv-6Q`): больше двух минут висело «язык звука не определён»,
  потом ролик определился русским и перевод не запускался (это верно).
- Таймлайн логов: `20:51:37 meta_local … (bot gate)` → 25 с → `20:52:02 late
  fail` → **HOLD** → ретраи по 45 с (`n=1`, `n=2`) → `20:53:33 meta probe IOS
  st=OK lang=ru/captions-asr` → `translate skip (late meta)`. Окно ~90 с писало
  «не определён», хотя опрос продолжался.
- Причина: ветка `hardLate` ставила `metaPending`, но вызывала `showLangHold`
  (HOLD считался «честным», потому что серия ретраев долгая). Это противоречит
  правилу «пока `metaPending` — показывать ожидание».
- Теперь в `hardLate` вызывается `langWaitStatus(id)`: всё время серии (до 8
  ретраев по 45 с) окно показывает «определяю язык звука… / OK — перевести
  сразу», а `showLangHold` остаётся только на исчерпании попыток.
- Проверено на `.100` (свежий APK): `P541-Kmv-6Q` → `translate wait: lang
  pending`, затем три `late retry` (25 с, +45 с, +45 с) без `translate hold`,
  на третьем `meta probe ANDROID st=OK lang=ru` → `meta_local lang=ru late` →
  `translate skip (late meta)`. HOLD не появлялся.

## 06.11 (вечер): OK съедал первое нажатие при фокусе на кнопке бара
- Симптом: открыть бар плеера, навести фокус на любую кнопку, нажать OK —
  срабатывала кнопка перевода, а нужная кнопка только со второго раза.
- Причина: хоткей HOLD (`holdPending`) перехватывал OK в capture-фазе на
  `document` при любом фокусе, включая кнопки плеера. Логи:
  `kdiag cap kc=13 af=YT-BUTTON-CONTAINER` + `hotkey OK kc=13 -> force translate`.
- `focusOwnsKey()`: OK принадлежит контролу, только если `activeElement`
  (или его предок) попадает в `FOCUS_CTRL` — `ytlr-button`,
  `yt-button-container`, `button`, `[role=button|menuitem|checkbox|radio]`,
  `a[href]`, `input/select/textarea`, `ytlr-player-actions-container`,
  `ytlr-menu-item`, `ytlr-playlist-item`, `ytlr-toggle-button`,
  `ytlr-icon-button`, `ytlr-compact-link`. Наша панель (`#vot-ui-root`) и
  `#vot-status` исключены отдельно.
- Важно: проверка «что угодно, кроме body» ломала хоткей — при скрытом баре
  фокус уезжает на `YTLR-WATCH-DEFAULT`, и OK переставал форсировать перевод.
  Поэтому список именно интерактивных узлов.
- Проверено на `.100` (`oKIkvEjI2WE`, стабильный HOLD):
  - фокус на кнопке бара (`kdiag cap kc=13 af=YT-BUTTON-CONTAINER`) —
    `hotkey OK` и `toggle:` отсутствуют, нажатие доходит до кнопки;
  - пульт не трогали, бар скрыт (`af=YTLR-WATCH-DEFAULT`) — `hotkey OK kc=13
    -> force translate` + `toggle: on` + `translate start`, хоткей работает.

## 06.11 (вечер): ложный HOLD на 25-секундном ретрае меты
- Симптом (ролик на полчаса `C45RuVktN_Y`): окно писало «язык звука не
  определён / нажмите OK», а через ~25 с перевод включался сам — срабатывал
  поздний ретрай `/meta_local` после бот-гейта. Пользователь видел «не
  определён» там, где определение ещё шло.
- `state.metaPending = id` ставится в начале `fetchMeta` и на каждом
  запланированном ретрае (META_GAPS, 25 с после гейта, 45 с-цепочка);
  снимается при найденном языке и при исчерпании попыток.
- Пока опрос идёт, `startTranslation` вместо HOLD показывает sticky-окно
  «Перевод: определяю язык звука… / OK — перевести сразу» (sticky нужен,
  чтобы OK на пульте по-прежнему форсировал перевод). «Язык звука не
  определён» (`showLangHold`) появляется только после неудачи позднего
  ретрая / исчерпания `META_GAPS`.
- Проверено на `.100`: `C45RuVktN_Y` → `translate wait: lang pending` →
  `meta_local en` → `translate resume` → `translate start lang=en` →
  `resp status=1`, HOLD не появлялся. `oKIkvEjI2WE` (трейлер без речи, гейт)
  → HOLD только после `meta_local late fail` (20:23:04), как и задумано.

## 06.11 (вечер): `originalFormatLang` не видел `streamingData` — `ar` вместо `en`
- `hj3qDOx9g8g` (английский оригинал + десятки автодублей) после первого
  фикса всё равно давал `meta probe … lang=ar/captions-asr` →
  `translate start lang=ar`. Причина: `originalFormatLang` искал
  `adaptiveFormats`/`formats` на **верхнем уровне** player-ответа, а они
  лежат в `streamingData`. Форматы не находились, `lang` оставался пустым,
  и в дело шли ASR-субтитры дубля (`ar`). Теперь массивы читаются из
  `streamingData` (верхний уровень оставлен фолбэком).
- `publishSource*`/`sabrParamsFromCfg`: `xtags` — base64 protobuf, поэтому
  `toLowerCase().indexOf("dubbed")` по сырой строке никогда не срабатывал
  (`dubStripped=0`, хотя дорожка — дубль). Проверка идёт по `xtagsText(xt)`.
- `publishSource` (ранг `job`, выше `track`) при срезанном дубле больше не
  публикует язык дубля: берёт `lang`/`acont`/`role` из предыдущей записи
  этого же видео (там `en` из `track`/`default`); если предыдущей нет —
  пишет пустой `lang` и `role=PLAIN` (в `served` уже стоит `PLAIN`).
- Проверено на `.100` (APK `tt203_bridge.apk`): `hj3qDOx9g8g` →
  `meta probe … ANDROID st=OK lang=en/xtags-original atid=en-US.4` →
  `meta_local … lang=en from=xtags-original 978ms` →
  `translate start lang=en` → `translate resume: audio lang=en` →
  `resp status=1` → `play offset=0.0`. `/source`: `lang=en`,
  `role=ORIGINAL`, `trackId=en-US.4`, `phase=default`.
- Побочно замечено: за ~1.5 с до `meta_local` мелькает
  `translate hold: source lang unknown (source=none)` и сразу
  `translate resume` — авто-резюм работает, но sticky-окно HOLD на этот
  кадр может успеть показаться.

## 06.11 (вечер): «иностранный ролик ошибочно определился русским»
- Две причины и обе закрыты:
  1) мост брал язык из `videoDetails.defaultAudioLanguage` — у автодублированных
     роликов это язык **дубля** (ТВ-плеер его и выбирает), а играем мы оригинал
     (`sp.xtags=""`). Теперь `fillLang` сначала ищет язык **оригинальной**
     дорожки по `xtags`/`audioTrack` (`originalFormatLang`, `langFrom=
     xtags-original`); если в ответе только дубли — ставится `dubOnly=1`, и
     `defaultAudioLanguage` не используется вовсе (лучше hold, чем неверный ru).
  2) страница тоже публиковала `vdlang` (тот же `defaultAudioLanguage`).
     `skipTrusted()`: молча решаем «ролик на вашем языке» только при
     `confidence=HIGH`; если язык пришёл из `defaultLanguage`/`vdlang`, вместо
     `translate skip` показываем sticky «похоже, звук на русском — OK, всё равно
     перевести» (`state.origLangFrom`, `skip unconfirmed` в логе).
- `origLangFrom` хранит источник языка (`captions-asr`/`vdlang`/`xtags-original`/
  `meta_local`) и сбрасывается в `resetSession`.
- Мост: `/meta_local?…&retry=1&basic=1` — поздняя попытка только ANDROID/WEB/IOS
  и мимо негативного кэша (бот-гейт проходит сам). `playabilityStatus.reason`
  теперь в логе (`why=`) и в ответе (`why`), так что «не бот» и «нужен вход»
  различимы.
- В `build_bridge.ps1` добавлен `javac -encoding UTF-8` — русские комментарии
  в `Bridge.java` иногда не маппились в windows-1251 и ломали сборку.
- Проверено: `1OqTWGzD0Cs` → `meta probe … ANDROID st=OK lang=en/captions-asr`
  → `translate start lang=en` → `resp status=1` → `play offset=0.0`.

## 06.11 (вечер): visitorData страницы снимает бот-гейт
- Причина «опять не определил язык»: `meta_local` минтил po-токен под
  **собственный** visitor id моста (`PoToken.get(...)` → свежий
  `visitor_id`). Яндекс быстро помечает такой visitor ботом, и все 6
  клиентов отвечают `LOGIN_REQUIRED` — язык не определялся вообще.
- Фикс: страница отправляет `visitorData` из `ytcfg('VISITOR_DATA')` в
  `/meta_local?videoId=…&visitorData=…`; мост передаёт его в
  `PoToken.getWithVisitor`. Этим же id страница сама стримит видео, поэтому
  гейта нет.
  Проверено после чистой установки: `meta vd page=476` →
  `meta probe … ANDROID st=OK lang=en/captions-asr` → `meta_local … 385ms`
  → `translate start lang=en`. На `dF0X_FikdMI`: HOLD → через 1.4 с
  `translate resume` → `translate start lang=en` → `resp status=1`.
- Лестница опроса языка сокращена с 9 до 4 шагов (`META_GAPS`
  `[500,1200,3000,6000]`): каждый заход перебирает 6 клиентов, 60 запросов
  подряд сами провоцировали гейт. При `LOGIN_REQUIRED`/`not a bot` после
  второй попытки опрос прекращается (`meta_local … lang unknown (bot gate)`).
- `req <method> <path>` в логе обрезается до 120 символов: `visitorData`
  бывает 400+ символов и забивал logcat.

## 06.11 (вечер): стагнация поллинга перевода
- У роликов без речи Яндекс отвечает `status=2 rem=5` и подсказка не
  двигается. Раньше опрос шёл вечно каждые 5 с (`poll in 5s rem=5 n=18…`).
- `poll()`: `state.lastRem`/`state.stall`. После 12 ответов с тем же rem
  (`~60 с`) пауза растёт до 15 с (`STALL_SOFT`/`STALL_DELAY`), статус —
  «сервер обрабатывает звук дольше обычного…». Отказ только после 24
  стагнаций (~4 мин без прогресса): «похоже, в ролике нет речи»
  (`poll stall 24 rem=5 — stop`).
- Жёсткий отказ через 60 с сначала поставил, но `oKIkvEjI2WE` (трейлер без
  голосов) в итоге доехал до `status=1` через несколько минут — такой порог
  убивал живой перевод, поэтому он мягкий.

## Цель
Приставка автономна (без ПК). Язык оригинала определяется многоуровнево
с оценкой достоверности; Яндекс получает язык оригинала, Cobalt играет оригинал.

## Ограничения
- `.100:5555` — отладка, `.200:5555` — только после E2E.
- Без PR/коммита, `cfg.json` не коммитить. `vot.js`/`vot_net.js` — только
  edit/write + `node --check`.
- Панель фильтров поиска (правая от клавиатуры) — не регрессировать.
- OAuth-токен живёт ТОЛЬКО в `vot_config_cache.json` моста (бэкап
  `/data/local/tmp/votcfg.json`); после каждой установки APK восстанавливать.

## Сделано (этот заход)
- `parseXtags`: разделитель в protobuf — служебные байты, не `=`.
- `dcr=1` больше не `descriptive` (это DRC, а не описание); реальный оригинал
  `ru.4` перестал падать в низший ранг.
- `publishDefaultTrack` → `POST /track phase=default` (ранг между `page` и
  `track`); `mapped=0` не публикуется; `publishTrackInfo` отбрасывает
  `mapped!=1`.
- `pageSabrUsable`: пара «wire url + тело POST» теперь годится и из
  захваченного запроса плеера (`/sabrreq`), не только из `/sabrcfg` — ушло
  12-секундное ожидание «no fresh player config» и фолбэк на клиентов с
  `LOGIN_REQUIRED`.
- `sabrParamsFromCfg`: работает и без `/sabrcfg` (берёт url+ucfg из `/sabrreq`).
- `publishBridgedDefault` (в мосте, внутри `meta_local`): если страница не
  увидела player-ответ, дорожка по умолчанию публикуется как `phase=default`.
- `meta_local`: `itPlayer` теперь с po-токеном (`PoToken.getWithVisitor`);
  без него WEB отвечал `LOGIN_REQUIRED` почти всегда.
- `fillLang`: если в player-ответе нет `audioTrack.id` (`audioTracks:[""]`),
  язык берётся из ASR-субтитров (`kind=asr` / `vssId=a-*`) как `meta_local`
  с `langFrom=captions-asr` (MEDIUM). Ручные субтитры не используются
  (unknown beats wrong). Диагностика: `captionLangs` в ответе `/meta_local`.

## Проверено на `.100` (05.11, APK `tt203_bridge.apk`)
- ru-оригинал (`a5h6WZoNTgI`, `yf2IKXyKj3c`): `source … role=ORIGINAL lang=ru
  phase=default` → `translate skip`; тост «ролик на вашем языке «русский»
  (перевод не нужен)».
- en-оригинал (`9wq3VHsL_bE`, NASA): `playtrack … id=en-US.4 lang=en
  mapped=1` → `source … phase=track` → `translate start lang=en` →
  `resp status=1 tid=462770675` → `play https://vtrans.s3-private…` →
  тост «Перевод: ГОТОВО — играю», `resync av≈vv`. Перевод Яндекса заработал
  без ПК и без `audiosrc` (у ролика был кэш перевода).
- Панель «Фильтры» поиска на месте (не регрессировала).
- 06.11, прогон ~8 ru-роликов: 5 определились как `ru` через `bridged default`
  (`audioTracks:["ru.4"]`), 3 — без `audioTrack` вообще
  (`R7WC5NHrO_w`, `37m9DBC_5Ls`, `Fi6Bk1iyEX4`) и уходили в hold
  (`bridged default … unmapped=1 keys=[]`). После фикса ASR-фолбэка все три
  дают `meta_local … lang=ru from=captions-asr` → `translate skip (late meta)`.
  E2E проверено на `37m9DBC_5Ls`: тост «ролик на вашем языке «русский»».
- `DqFf1x6YoFw`: hold ~0.8 с (страница не увидела player-ответ), затем
  `translate skip (late meta)` — норма, но плашка на секунду мелькает.

## 06.11: «99 %» и закачка видео закрыты
- Причина «99 % и качает дальше»: `audiosrc` реплеил тело плеера как есть, а оно
  выбирает и видео (`field 22 = 137`) — 668-секундный ролик качался как 106 МБ
  `itag=137` при ~10 МБ аудио.
- Проверено на живом устройстве (`/sabrmix`): собственное тело (`our`) с большим
  (6 КБ) ustreamer-конфигом получает `sabr.malformed_config`, а тело страницы с
  нашей `field 2` (`page-sel140`) отдаёт `itag=140` при конфиге любого размера.
- Поэтому `audioSourceJob` берёт тело плеера и меняет только выбор формата
  (`Sabr.mix(tpl, our, 2)`), стрипает `buffered_ranges`, а `itag` в `Sabr.run`
  теперь фильтрует медиа: видео-поток из смешанного ответа отбрасывается
  (`byItag` в логе).
- Порог успеха: файл < 100 КБ больше не уходит как «дорожка» (раньше один
  init-сегмент 723 Б маскировал провал).
- E2E `1OqTWGzD0Cs` (414 с, en, Яндекс `audio=no`): `selAudio itag=140` →
  8.0 МБ за 15 с (`byItag={140=8.0M, 136=42.8M}`) → 2 чанка → `status=1` через
  ~50 с → `play` + `restart video from 67.4s`, `vol tr=100 orig=10`.

## Открыто
- `audiosrc` проверен на en-роликах без перевода (`bqVhMnM2O18`, `1OqTWGzD0Cs`),
  но клиенты для `meta_local`: `TVHTML5_SIMPLY_EMBEDDED_PLAYER` — no audio
  format, `VISIONOS/ANDROID/IOS/WEB/TVHTML5` — `LOGIN_REQUIRED`, живой только
  `ANDROID_VR`.
- Ролики без `audioTrackId`/xtags и без ASR-субтитров (напр. `m1ZbYo-xGB0`)
  → язык UNKNOWN → hold; это осознанно («unknown beats wrong»), лечится
  политикой «Перевести с автоопределением».
- `meta_local` местами всё ещё `LOGIN_REQUIRED` (po-токен не всегда спасает).

## Следующий шаг
1. `.200` (SberBox): APK установлен, миграция кэша проверена
   (`audioMode:"local"`, `v:2`, токен сохранён); отладка на нём запрещена,
   smoke-тесты — только на `.100`.
2. Проверить «Звучит сейчас» в меню `vot-dub` на живом ролике.
3. Долгие ролики: видео-поток в ответе всё ещё скачивается и выбрасывается
   (~40 МБ на 4 минуты); при желании — отдельный вариант без `field 22`.

## 06.11: единое окно статуса перевода
- Раньше этапы (`#vot-status`) и короткие тосты (`#vot-toast`) были двумя
  плашками с «плавающим» размером. Теперь окно одно: `#vot-status`, фиксировано
  `480x100` (`padding 20 + текст 68px/3 строки + шкала 12`), текст в дочернем
  `#vot-status-text`, шкала — отдельный узел. `#vot-toast` удалён из CSS/DOM,
  `VOTUI.toast()` делегирует в `window.VOT_STATUS_TOAST`, который перекрывает
  этап на время показа (`statusToast`, по умолчанию 3800 мс).
- Видимость решает `statusApply()` по классу из `setStatus`:
  `#f5a623` = busy и `#e53935` = error — видны всегда (перевод идёт, даже если
  бар плеера спрятан); `#4caf50` = done и `#90a4ae` = idle — только пока видны
  элементы управления плеера. После запуска перевода окно не «висит» поверх
  видео: оно гаснет вместе с баром.
- Гейт `playerControlsVisible()`: (1) `findVideo()` и видео занимает ≥50 %
  вьюпорта, (2) `ytlr-player-actions-container` с ненулевым rect и пересечением
  с вьюпортом, (3) среди 8 предков нет `visibility:hidden`/`aria-hidden=true`
  и итоговая opacity > 0.05. Причина отказа — в лог:
  `st gate show=0 … why=novid|vsize|norow|rect0|offscreen|vis|aria|op…`.
- Проверено на `.100`: на главной `why=rect0` (скрытый плеер в DOM), в ролике
  с открытым баром `show=1 why=ok`, после автоскрытия бара `show=0 why=aria`,
  во время перевода `show=1 kind=busy why=aria` (busy игнорирует гейт).
  Скриншоты `_shots/s5.png`, `s6.png` — окно одного размера на разных этапах.
  Готовность: `show=0 kind=done why=aria` (бар скрыт) → `show=1 kind=done
  why=ok` после появления бара — «хвоста» после запуска перевода нет.

## 06.11: sticky-HOLD, OK для ручного запуска, больше клиентов меты
- HOLD-окно теперь видно и без бара (`sticky=1`): `_shots/hold2.png`,
  `hold3.png`, `bond1.png` — «язык звука не определён» на чёрном экране.
  Лог: `st gate show=1 kind=idle sticky=1 why=rect0|norow`.
- Ручной запуск при HOLD: перехват **OK** (keyCode 13/23) в capture-фазе,
  только пока `holdPending()` (langWaitForId этого ролика + sticky idle).
  Проверено на `oKIkvEjI2WE`: `hotkey OK kc=13 -> force translate` →
  `toggle: on` → `translate start … lang=auto` → `resp status=2 rem=71` →
  поллинг. F4 (115/134) оставлен для клавиатуры, но `adb input keyevent 134`
  до JS не доходит (Cobalt отдаёт kc=177 + 115 только в kiiag, обработчик
  не срабатывает), поэтому в тексте окна осталось только «нажмите OK».
  Android KEYCODE_F4=134, DOM keyCode F4=115 — оба в обработчике.
- `meta_local` перебирает 6 клиентов: ANDROID → IOS → TVHTML5_EMBEDDED →
  WEB → ANDROID_VR → TVHTML5; статусы в ответе по именам клиентов
  (`androidStatus`, `iosStatus`, …). Это не помогло `oKIkvEjI2WE` (Bond-
  трейлер): у ролика нет ни `audioTracks`, ни ASR-субтитров, ни
  `defaultAudioLanguage`, ни `audioTrack.id` — `ANDROID st=OK` с пустыми
  `tracks/caps`, остальные LOGIN_REQUIRED/ERROR.
- Причина «не определяет en» на трейлерах: в трейлере нет голосов (только
  музыка/шумы), поэтому у него и нет языковых метаданных — ASR-субтитров
  нет. Это не баг определения: язык у такого ролика отсутствует физически.
  HOLD + OK (авто) — корректное поведение; для роликов с речью
  (`1OqTWGzD0Cs`, `UNwV7qtH6y4`, `-nY5b9fBHxw`) определение идёт через
  `captions-asr` и перевод стартует сам.
- `playtrack`/`reportPlayingTrack`: `audMapFresh(id)` (videoId + TTL 120 с) и
  сверка с `capVideoId()`; иначе константный `en-US.4` из SABR размечал
  чужой ролик как «english original». `playtrack skip … stale map` /
  `(mismatch)` в логе.
- `fetch player` теперь логируется per-vid (`fetch player vid=…`), чтобы
  видеть ответы preview-роликов; watch player-response JS-хуку по-прежнему
  не виден.

## Отложенный баг: навигация пульта после простоя
- Симптом: после ~5 с без нажатий бар плеера скрывается; первое «вправо»
  ставит фокус на прогресс-бар (`ytlr-multi-markers-player-bar-renderer`),
  следующее — на вырожденный `yt-focusable-container 1920x12`
  (`yt-focus-container 0x0`); YouTube уходит в режим глав/маркеров и ряд
  кнопок демонтируется (`btn=3 our=0`).
- `injectVotBtn` не виноват: в рабочем состоянии `our=1`, в сломанном — 0.
- План лечения (не делать без явной просьбы): перехватывать `ArrowRight`, когда
  фокус в `ytlr-progress-bar` / 12px-контейнере, и переносить фокус на первую
  кнопку `ytlr-player-actions-container`.
- Временный `bar dump` в `vot.js` (~4079–4120) пока оставлен для диагностики:
  печатает список кнопок с rect/aria/dis.

## 09.11: громкость оригинала при переводе (enforceVolume)
- Симптом: при включённом переводе оригинал «часто» звучал на 100%, хотя
  задано 10%; ручная коррекция ползунком в меню помогала.
- Причина: `applyVolume()` вызывался только на старте `/play`, при смене
  префа и на стопе. Cobalt пересоздаёт `<video>`/сбрасывает `volume` при
  смене ролика, дорожки, после рекламы и на переходах — сброс не ловился.
- Фикс: `enforceVolume(why)` — сверяет `v.volume`/`v.muted` с
  `volPct('vol.original')` каждые 250 мс (отдельный таймер) и в `syncLoop`
  (1 с), плюс события `playing|loadeddata|volumechange|seeked`. При
  расхождении возвращает значение и пишет `vol enforce why=… want=… got=…`
  (лог ограничен 20 строками). Раз в 30 с — `vol watch want=… got=…`.
- Проверено на `.100` (09.11): `hj3qDOx9g8g` — 5 снимков `vol watch`:
  `want=10% got=0.1`; переключение на `C45RuVktN_Y` — два `vol enforce
  why=event/tick want=10% got=1` сразу после смены ролика, затем снова
  `got=0.1`. То есть сброс плеера теперь отлавливается в пределах тика.

## 09.11: патчи A-0001 (язык/HOLD/OK) применены
- `http()`: `timeout=20000` + `ontimeout` → зависший мост больше не оставляет
  `busy`/`metaPending` навсегда (D1).
- `fetchMeta`: выход при `curId !== id` до установки `metaPending`; ретраи
  `META_GAPS` запускаются только для текущего ролика (D2).
- Поздние ретраи (25 с и серия 45 с) при уже известном `origLang` снимают
  `metaPending`, а не просто выходят (D3).
- `metaAlive(id)` — сторож 70 с: если опрос сорвался, окно ожидания
  гарантированно превращается в HOLD с рабочим OK; снимается при сбросе
  ролика (D4).
- `startTranslation`: входная проверка `curId` (с допуском `getVideoId()===id`
  для ручного нажатия); `wait()` не запускает перевод прошлого ролика (D4').
- `writeSourceInfo` (мост): запись без языка не перекрывает запись с языком
  того же ранга/выше — `track lang=en` больше не теряется под `job {}` (D5).
  `publishSource`: язык из `phase=page` не повышается до факта (D6).
- `FOCUS_CTRL` расширен: slider/tab/link/option/switch/listbox/dialog,
  progress-bar, scrubber, tabs, chip, playlist-panel (D3 аудита).
- Прогон на `.100`: `hj3qDOx9g8g` — `meta_local en` → `translate start
  lang=en` → `play offset=0.0`; `P541-Kmv-6Q` — `meta_local ru (ASR)` →
  `translate skip (late meta)`; `timeout` и вечных `translate wait` нет.
- Повторный чистый прогон после ревью-правок (`xhr done`-guard, `langRescue`/
  `dropsKnownLang` в мосте): `hj3qDOx9g8g` — `watch detected` → `source …
  lang=en phase=default` → `meta_local en from=xtags-original 1322ms` →
  `translate waiting for source lang try=1` → `translate start lang=en` →
  `translate resp status=1` → `play offset=0.0`; `vol watch want=10%
  got=0.1` на 18:40:55 и 18:41:25. Патчи A-0001 закрыты.
- Замечание по методике: если deep-link приходит, пока приложение ещё
  поднимает домашнюю сетку (`ytlr-playback-preview` автоплей), watch-страница
  не открывается и `translate start` не будет — это не регрессия. Надёжно:
  дать приложению дойти до сетки, затем повторить `am start` (intent уйдёт
  top-instance и откроет watch).

## 09.11: перевод только названий роликов, меню не трогаем (L-0003)
- Скан DOM ограничен плитками `TT_CARDS` (`ytlr-tile-renderer`,
  `ytlr-compact-tile-renderer`, `ytlr-video-with-context-renderer`,
  `ytlr-compact-video-renderer`, `ytlr-playback-preview`,
  `ytlr-playlist-panel-video-renderer`); полный проход по документу убран —
  именно он подменял подписи `ytlr-guide-entry-renderer`, из-за чего «пропадали
  пункты меню».
- Внутри плитки обход теперь по `*`, а не по `span,div,h2,h3,yt-formatted-string,p`:
  YTLR использует обфусцированные имена элементов и заголовок не находился
  (`title_pass cards=12` без `title_apply`); после правки `title_apply n=2..5`.
- `ttIsList` в `vot_net.js` больше не включает `guide`: названия каналов из меню
  не попадают в кэш названий.
- Маркер-точка: `ttDotOf` ищет `span.vot-tt-dot` среди всех детей плитки;
  `ttSyncDots(cards)` вызывается перед подстановкой и возвращает точку после
  перерисовки плитки, а при исчезнувшем переводе снимает её. `ttSweepDots` и
  структурный `ttCardOf` удалены.
- Проверено на `.100` (поиск `what time iphone 17 pro review`): переводы
  названий («Безумный! В новой материнской плате iPhone 17», «iOS 27 против
  Color OS 17 — плавность, AI, Siri и многое»), синие точки в левом верхнем
  углу плиток; развёрнутое меню (Поиск, Главная, Подписки, Библиотека,
  Видеоигры, Новости, DW News, Shorts, Настройки) без изменений; панель
  фильтров поиска на месте.


