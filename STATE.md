# STATE — TizenTubeCobalt + Yandex VOT (26.10.2026)

## Цель
Живые голоса Яндекса (VOT) в TizenTubeCobalt на Samsung TV
(`adb -s 192.168.1.100:5555`, `io.gh.reisxd.tizentube.cobalt`),
**serverless**: в рантайме только API Яндекса + статика GitHub, без ПК/своего сервера.
UI — JS-оверлей. Ветка `fix-vot-runtime-injection`, PR в `main` не делать. История — `STATE_ARCHIVE.md`.

## Работает (проверено 26.10)
- Перевод E2E на ТВ без загрузки звука: `status=2 rem=N` → `status=1` → `play`
  (`vtrans.s3-private.mds.yandex.net`), оверлей и воспроизведение живы; 文A = выключатель,
  пункты и ползунки в шестерёнке; `skipLang=ru`.
- **Яндекс сам переводит ролик целиком**: `wOp_wgp-f9I` (`de`): `2 rem=151` → `1` за ~60 с,
  **COVERAGE 513.9/514.0 = 100 %** (mp3 8 223 391 B, 128 kbps). `status=6` — его транзиентный сбой.
- 8 из 8 холодных (ролик, язык) пар отдали `status=2` без единого нашего байта:
  `1fw8LHH-aMQ` fr/es/it, `wOp_wgp-f9I` fr/es, `32wH-_WKCZA` fr/pl, `ki1URTzrzhQ` fr.
- `audioMode:"off"`, захват MSE выключен (`CAP_ON=false`, в логе `cap=0`), `pcFill:false`;
  принудительный AAC (`patchCodecs`) тоже включается только при `capture` — плеер штатно играет opus.
- **`retrySix` проверен живьём (22:11):** `status=6` → `retry 1/3 in 15s` → `6` → `retry 2/3 in 45s`
  → `status=1` → `play`; без единого нашего байта, звук не сломан (`drop=0`).
- Мост: `/cap/*`, `/audio`, `/yt_url`, `/meta_local`, `/config`; dex 56 344 B установлен;
  при старте `capCleanupStale()` удаляет старые `cache/cap_*.mp4` (проверено: файл 6.3 МБ удалён).

## Закрытые пути (не возвращаться)
- **Прямые ссылки `/yt_url` → `/audio`**: ANDROID_VR отдаёт 4 формата с `n=false` и точным `clen`
  (itag 140: 8 318 128 B / 514 с), но с ТВ `audio ua[0..3] code=403` → `no user-agent accepted
  the audio url`. Без poToken googlevideo режет URL.
- **MSE-захват (путь E)**: файл валиден (`aac/44100/2ch`, gaps=0), но растёт со скоростью плейбека
  (за 40 с → ~46 с аудио, пакетов 51.4 %). Яндекс переводит только загруженное окно, а tid после
  частичной загрузки навсегда висит в `status=3` без url (замер: 10+ мин). Одна загрузка на ролик.
- **ПК-филлер**: yt-dlp → `Sign in to confirm you're not a bot`, `LOGGED_IN:false` — нужен новый
  экспорт `dev_server/yt_cookies.txt`. Не приоритет (`pcFill:false`).

## Правки в рабочем дереве (не закоммичено)
- `vot_bridge/java/vot/Bridge.java`: `capCleanupStale()` + вызов в `start()`; `capFileFor` снова
  проверяет `sCacheDir`; `/cap/upload` читает файл строго по `?videoId=`; `/cap/status?videoId=` →
  `fileSize`/`fileCurrent`.
- `dev_server/vot.js`: `retrySix()` при `status=6` (`SIX_RETRY_MS=[15000,45000,120000]`, сброс
  `altLangTried`), `state.sixTries` в дефолтах и при смене ролика; `capFill()` за `capFillAllowed()`.
- `dev_server/vot_net.js`: `CAP_ON` + чтение `/config` на старте (`cap on` только при `capture`).
- `dev_server/vot_config.json`: `audioMode:"off"`, `pcFill:false`, `fillMaxWait:240`.
- `serve_vot.py` `_resolve_fill_meta()`, `fill_audio.py` `_promote_youtube_domain()`.

## Следующие шаги
1. Ревью diff (`reviewer`) и коммит в `fix-vot-runtime-injection` (не пушить, PR не делать).
2. Следить за `retry`: если 3 попыток не хватает (ролик остаётся `6`), увеличить лестницу.
3. Если `status=6` станет регулярным и перевод будет теряться — вернуться к варианту A (SABR/UMP).

## Грабли (не наступать)
- **Нельзя `am force-stop`**: Cobalt теряет незаписанные куки. Выход — только штатный.
- `am start` на живой инстанс — no-op; пересоздать задачу: `am start ... -f 0x10008000`.
- Логи при старте теряются: буфер общий с `cobalt` (CSP-простыни) — снимать `logcat -s VotBridge`
  в файл ДО запуска.
- Бот-гейт `/yt_url`/`/meta_local`: 1 из 8–12 запросов, нужна тишина ~5 мин; у `/translate` гейта нет.
- Dev-сервер: `C:\Program Files\Python311\python.exe dev_server\serve_vot.py`; лог в `%TEMP%`.
- ТВ сам меняет ролики (автоплей) — «текущий» захват может принадлежать другому видео.
- Репо sparse-checkout: новые файлы — `git add --sparse`. CSS-анимации в Cobalt не идут.
