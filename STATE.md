# STATE — TizenTubeCobalt + Yandex VOT (29.10.2026)

## Цель
Живой перевод Яндекса (VOT) в TizenTubeCobalt **serverless**: API Яндекса в рантайме + статика
GitHub/CDN, без форка и без ПК-сервера. Ветка `fix-vot-runtime-injection`, PR в `main` не делать.
Тест: **`YNDX-00091` (magritte, Android 11, armeabi-v7a) `adb 192.168.1.100:5555`**,
пакет `io.gh.reisxd.tizentube.cobalt` 2.0.3, activity `dev.cobalt.app.MainActivity`.
**SberBox 192.168.1.198 НЕ ТРОГАТЬ.** История до 29.10 — `STATE_ARCHIVE.md`.

## ✅ 29.10 ~05:56 — E2E РАБОТАЕТ ПОЛНОСТЬЮ АВТОМАТИЧЕСКИ
`rtrdroYs67A` (4014 с), без ручных запросов: `translate start` (страница сама) → `status=6` +
tid → `POST /audiosrc` (сама) → `page-sabr` скачал **81 922 133 Б** itag 140 → 16 частей залито
→ Яндекс `status=5` → `status=1` + `audioUrl`, страница **включила перевод** (`play offset=…`,
`vol tr=100 orig=10`). Время: 74.8 с на аудио, ~3 мин до готового перевода.
Контроль на `hPV-Ql_KGzM` (4199 с): mp3 у Яндекса **4198.654785 с**, 67 179 877 Б — полная длина.

## Как это работает (три обязательных ингредиента)
1. **AAC вместо opus**: `/config.aac=true` (теперь дефолт) → страница в `patchCodecs` отвечает
   «нет» на `audio/webm|opus` в `MS.isTypeSupported` → плеер берёт `audio/mp4; codecs="mp4a.40.2"`,
   SABR отдаёт **itag 140**. С opus (251) файл — matroska/webm с 25 000 ошибок
   `non monotonically increasing dts` (сервер отдаёт перекрывающиеся фрагменты не по порядку).
2. **Init-сегмент из MSE**: SABR отдаёт сессии, которая уже играла, только media-фрагменты.
   Страница на первом `appendBuffer` аудио-SourceBuffer постит байты в `POST /mseinit?vid=&mime=`
   (723 Б, `ftyp/dash`), мост пишет их первыми в стейдж. Без init файл вообще не контейнер.
3. **Тело POST самого плеера без поля 3** (`buffered_ranges`): только эта форма даёт медиа
   (`raw=2`); наше тело → policy-only (`35/46/47`), `raw=1` (с полем 3) → 0 байт.
   Плюс пейсинг по таймингам части 35 (`d=`).

## Состояние кода
- `Sabr.java`: `Params.bodyTpl/bodyStrip`, `replayBody(tpl,time,strip)`, `parse()` частей
  35/52/53 (`nextDelayMs`), `stuckLimit/replayLimit`, `Result.initSegs/dupInit/declMs/pol`,
  `umpVarint` (заголовки) отдельно от `readVarint` (protobuf).
- `Bridge.java`: `/mseinit`, `mseInitFor(vid)`, `SabrStage.init(byte[])`, `capturedSabrBody(vid)`,
  `sAac` (дефолт true) + `/config.aac`, стейджинг в `vot_asrc.bin` → `uploadStaged` (5 295 308 Б),
  `mp4Head`, `/sabrfile?from=&max=` (4 МБ), `/sabrtest?page=1&raw=N&xtags=`.
- `vot_net.js`: `hookMse` → `mseInitSend`, `pullConfig` каждые 12 с (in-flight guard),
  `patchCodecs` (флаг `aac`).
- Ревью `reviewer` пройдено, обязательные фиксы внесены: `handleAudioRaw` отбивает части
  стале-поколения (`gen != sAsrcGen`), `SabrStage.init` пробрасывает `IOException`.
- `javac` OK, `node --check` OK (`vot_net.js` и `assets/vot.js`), закоммичено в ветку.

## 🔎 Известная проблема качества (следующее)
Плеер ТВ сам выбирает **автодуб**: в захваченном body/wire-url `xtags=acont=dubbed-auto:lang=ar`.
Значит и init, и SABR-медиа принадлежат арабской дорожке, и Яндекс переводит дубль, а не
оригинал. Нужно заставить плеер брать оригинальный трек (ytcfg/эксперимент авто-дубля) либо
просить SABR оригинал и брать init того же формата — проверить на ролике без дублей (xt тег пуст)
как контроль.

## 🧪 29.10 ~06:29 — прогон 3 роликов: авто-путь стабилен, но нужен «свежий» ролик
`rtrdroYs67A`, `hPV-Ql_KGzM`, `jNQXAC9IVRw` у Яндекса **уже в кэше** (`status=1` + `audioUrl`
через 5 с) → путь звука на них не проверяется. Настоящий тест дал автоплей:
`uXXBDBwl5RI` (179 с, свежий) — страница сама `translate start` → `status=6` → `audiosrc start`
(через 8.6 с) → `page-sabr itag=140 init=723` → `done 3 705 493 Б` за 5 с → `status=2`
(rem 27→5) → `status=1` + `audioUrl`, перевод включился. `mseinit` на всех 4 роликах
= 723 Б `audio/mp4` (`jNQXAC9IVRw` — 632 Б), смене ролика не мешает.
Диагностика `audfmt` (список аудиодорожек из player response) **не сработала** — в Cobalt
player response не виден ни через `ytcfg`, ни через XHR/fetch (`has streamingData=false`),
поэтому дорожки так не получить. `xtags` у свежего ролика снова `acont=dubbed-auto:…`.

## Следующий шаг
1. ✅ Закоммичено: `c898042e7f1` (`vot: serverless полный аудиотрек через SABR replay`).
   APK на ТВ — сборка 06:16 (с фиксами ревью).
2. Разобраться с `dubbed-auto`: как отключить автодуб в плеере Cobalt (или запросить оригинал).
3. Прогонять только **свежие** ролики: закэшированные отвечают `status=1` сразу и путь звука не тестируют.

## Грабли
- `am force-stop`/`kill` запрещены; install APK убивает процесс.
- `am start … -f 0x10008000` при живом приложении убивает surface → чёрный экран (только холодный старт).
- Deep-link intent `VIEW watch?v=…` перезагружает страницу на выбор профиля (не всегда ведёт в ролик).
- `adb forward tcp:18114 tcp:8013`; старый `18014` принадлежит `.198` — не трогать.
- Логи только `adb logcat -v time -s VotBridge:V`.
- `Bridge.java` с BOM (`utf-8-sig`); APK `tt203_bridge.apk`; `assets/vot.js` = vot_ui.js + vot.js + vot_net.js.
- `/translate` без tid: вердикт читается тем же `firstRequest:false` + тот же `videoUrl`+`duration`.
- `/sabrfile` целиком = OOM; тянуть по 4 МБ (`from`/`max`).
