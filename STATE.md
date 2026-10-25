# STATE — TizenTubeCobalt + Yandex VOT (26.10.2026)

## Цель
Живые голоса Яндекса (VOT) в TizenTubeCobalt на Samsung TV
(`adb -s 192.168.1.100:5555`, пакет `io.gh.reisxd.tizentube.cobalt`), **serverless**: в рантайме только
API Яндекса + статика GitHub, без ПК/своего сервера. UI — JS-оверлей.
Ветка `fix-vot-runtime-injection`, PR в `main` не делать. История — `STATE_ARCHIVE.md`.

## Работает (проверено)
- Перевод E2E без загрузки звука: `status=2 rem=N` → `status=1` → `play`
  (`vtrans.s3-private.mds.yandex.net`); 文A = выключатель, пункты/ползунки в шестерёнке; `skipLang=ru`.
- Холодная пара на ПК (`vot_probe.py poll X23-S8hAa3c 692.5 en`): `2 rem=63` → `1` за 46 с — API жив.
- `audioMode:"off"`, захват MSE выключен (`CAP_ON=false`, в логе `cap=0`), `pcFill:false`;
  `patchCodecs` включается только при `capture` — плеер штатно играет opus.
- Мост: `/cap/*`, `/audio`, `/yt_url`, `/meta_local`, `/config`, `/failaudio`; dex 56 344 B;
  при старте `capCleanupStale()` удаляет старые `cache/cap_*.mp4`.
- Второе устройство `192.168.1.198:5555` (SberBox_Top): APK установлен, мост и оверлей живы,
  перевод работает; проброс на ПК — `tcp:18014` (ТВ1 занимает 18013).

## Главный вывод по `status=6` (замеры 26.10, важно)
- `6` бывает двух сортов, по ответу их не отличить:
  (а) транзиентный — тот же tid `X23-S8hAa3c` через ~3.5 мин отдал `1` с url;
  (б) мёртвый — `l08V8bNg53I`, `1GZ5pFwdU2M` (en): `6` ~590 с → `2` (remaining тает) → `0`
      («Возникла ошибка при переводе»), url нет и через 11 мин.
- **`fail-audio-js` + пустое аудио (трюк форка SmartTube) проверен A/B и НЕ помогает:**
  `PUT` → 200 `{"status":1}`, задача оживает (`6` → `2` за 0.2 с), но сервер считает звук
  недоставленным: `remaining` 58→12 и через **51 с** терминальный `0`. fid
  (`fallback-empty-audio:…` vs `web_api_get_all_generating_urls_data_from_iframe`) роли не играет.
  На уже мёртвом `0` он лишь пересоздаёт задачу (`0` → через 228 с `3 tid=null` → через ~390 с новый `6`).
  Итог: fail-audio = ускорение падения, не эскалация → в клиенте не отправляем (`faMode:"skip"`).
- Корень прошлого бага: на `6` бросали tid и слали новый `firstRequest=true` → живая задача умирала.

## Сделано сейчас (не закоммичено)
- `dev_server/vot.js`: `retrySix` удалён; на `status=6` → `holdSix()` — опрос ТОГО ЖЕ tid
  (`firstRequest=false`) каждые 30 с, бюджет 10 мин на шард; после бюджета `escalate()`
  (другой шард / ПК), на `status=0` — как раньше. `poll(id,dur,rem,holdMs)` + `state.sixSince/sixWaits`,
  честный статус «сервер готовит звук…».
- Прочее из предыдущего этапа: `Bridge.java` `capCleanupStale()` и `/cap/*` по `?videoId=`,
  `vot_net.js` `CAP_ON` только при `capture`, `audioMode:"off"`, `pcFill:false`, `faMode:"skip"`.

## Следующие шаги
1. E2E на ТВ2 (192.168.1.198): холодный ролик → `hold tid` → `status=1` → `play`
   (логи: `resp status=6` → `hold tid=… waited=…s` → `status=1` → `play`).
2. Ревью (`reviewer`) и коммит в `fix-vot-runtime-injection` (не пушить, PR не делать).
3. Если `6` останется частым и перевод будет теряться — вариант A (SABR/UMP) или ПК-филлер
   с новым `yt_cookies.txt`.
4. Serverless-долг: оверлей и конфиг тянутся с `http://192.168.1.186:8013` каждые 8 с — без ПК
   перевода нет; зашить в dex или отдавать со статики GitHub.

## Закрытые пути (не возвращаться)
- **`/yt_url` → `/audio`**: ANDROID_VR даёт 4 формата с `n=false` и точным `clen`, но с ТВ
  `code=403` для всех UA — без poToken googlevideo режет URL.
- **MSE-захват (путь E)**: файл валиден, но растёт со скоростью плейбека; partial upload
  навсегда висит в `status=3` без url. Одна загрузка на ролик.
- **ПК-филлер**: yt-dlp → `Sign in to confirm you're not a bot`, нужен новый `yt_cookies.txt`.

## Грабли (не наступать)
- **Нельзя `am force-stop`**: Cobalt теряет куки. Пересоздать задачу: `am start ... -f 0x10008000`.
- Логи при старте теряются (буфер общий с `cobalt`) — снимать `logcat -s VotBridge` в файл ДО запуска.
- Бот-гейт `/yt_url`/`/meta_local`: 1 из 8–12 запросов; у `/translate` гейта нет.
- Dev-сервер: `C:\Program Files\Python311\python.exe dev_server\serve_vot.py`; лог в `%TEMP%`.
- ТВ сам меняет ролики (автоплей). Репо sparse-checkout: новые файлы — `git add --sparse`.
- `Bridge.java` содержит BOM (читать `utf-8-sig`). CSS-анимации в Cobalt не идут.
