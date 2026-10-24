# STATE — TizenTubeCobalt + Yandex VOT (24.10.2026)

## 1. Цель
Yandex VOT в TizenTubeCobalt на Samsung TV (`adb -s 192.168.1.100:5555`,
`io.gh.reisxd.tizentube.cobalt` 2.0.3): быстрый старт, живые голоса, без отказов,
без заикания и фонового звука. Фокус — закрыть `status=6` через PC-филлер.

## 2. РАБОТАЕТ
Кэш Яндекса шардирован по полю 8 (`language`); `state.lang='en'` ⇒ `status=1` <1 с.
При `status=6` — повтор в другом шарде, затем PC-филлер (`/fill`).

## 3. PC-филлер: что выяснено
- Механика: `yt-dlp` (cookies Chrome, `--js-runtimes node`, `player_client=web_embedded`)
  → chunked `PUT /audio` (5 295 308 B, индекс с 0) → `status=1`. Чужой tid принимается
  (ПК залил в tid с ТВ — `vZE_ipeSozs`, `status=1`).
- **ФОРМАТ**: itag=251 (opus/webm) Яндекс принимает (`http=200`), но синтез НЕ стартует —
  вечный `status=6` (`CX3QRLSTrtw`, 11 мин). Нужен только m4a/AAC: `ACCEPTED_EXT`.
- **МУЛЬТИЯЗЫЧНЫЕ РОЛИКИ**: у них нет простого `140`, только `140-0/140-3…` ⇒ `-f 140`
  падает «Requested format is not available». Рабочий селектор:
  `140/bestaudio[ext=m4a]` (дефолт в `fill_audio.py`, `serve_vot.py`, `vot_config.json`).
  `download()` идёт format-major: `[fmt, "140", "bestaudio[ext=m4a]"]`, отвергнутый
  контейнер помечается в `refused` и не повторяется на других клиентах.
- **ОКНО ЗАГРУЗКИ (ПОДТВЕРЖДЕНО 24.10)**: `remaining` в `status=6` — обратный отсчёт,
  который сам не перезапускается; заливка после закрытия окна принимается (`200` на всех
  чанках) и игнорируется. `EXVnDVrJlBU` (140, 11.7 МБ): без kick — `status=6` навсегда;
  с `kick` (`first=true`) прямо перед upload — `status=2` → `status=1` за ~25 с.
  Поэтому `fill()` всегда делает `kick` ПЕРЕД upload, а если 45 с висит `status=6` —
  повторный `kick` + повторную заливку того же буфера.
- **ШАРД = ЗАДАЧА (24.10)**: tid уникален для (ролик, шард). ТВ после неудачи в `en`
  переключается на `auto` и поллит **auto**-tid; если ПК заливает в en-задачу, ТВ видит
  `status=6` навсегда (`A_diEEpAfpM`: ПК `status=1` в en, ТВ — 6 в auto, tid'ы разные).
  Поэтому `serve_vot.py` берёт язык от ТВ (`lang or fillLang`), а `fill_audio.py` больше
  НЕ перезаписывает tid с ТВ; при расхождении tid пишет `WARN kick tid != tv tid` и при
  повторном расхождении падает быстро: `shard mismatch: tv tid=… kick tid=… lang=…`.
- Заливка в чужой tid работает только если это **та же** задача (vZE_ipeSozs).
- `status=0` после заливки: если tid пришёл с ТВ — создаём свою задачу и льём в неё.
- `status=6` не всегда приговор: у `L_jWHffIx5E` сам стал `2` через 102 с, но кончился
  `0` (`shouldRetry=1`).
- Мост: `handleFill` (`/fill`, daemon-поток) + `handleFillStatus` (`/fill_status`,
  GET-прокси на ПК, объявлен ДО `/fill`). APK пересобран и установлен, `/fill_status`
  отвечает `{"state":...}`.
- `serve_vot.py`: `start_fill` игнорирует дубликат только пока джоба свежая
  (`fillMaxWait+180` с), иначе перезапускает (иначе «run» навсегда блокирует ролик).
- `vot.js`: ветка ожидания `pcTried && !pcDone && (6||0)` — `poll(…,2)` раз в 3 с,
  бюджет `PC_FILL_WAIT=600000`, каждые 4 итерации `GET /fill_status`; `ok` → `pcDone` +
  `startTranslation` с нуля; `err/offline` → сообщение. `node --check` чисто.

## 4. Проверено на ТВ (24.10, 10:16)
Полная цепочка работает дважды: `status=6 -> other shard` → `status=6 -> pc fill` → `fill queued`
→ kick вернул **тот же** tid (`WARN`/`shard mismatch` нет) → ПК залил (140, 27.5 МБ / 35.2 МБ,
все чанки `200`) → ТВ `status=2` → `status=1` (62 с / 90 с) → `restart video` + `play offset=0.0`.
`/fill_status` = `{"state":"ok","status":"1"}`; `FAILED` ноль. Ролики: `LoKPupeKW08` (lang=auto),
`UT9Wlk64v7U` (lang=en). Ветка `status=0` в прогоне не встречалась (не проверена живьём, но код-путь общий).
Важно: `am start -a VIEW` без `-n` уходит в `ResolverActivity` — открывать явно
`-n io.gh.reisxd.tizentube.cobalt/dev.cobalt.app.MainActivity`.

## 5. Дальше
1. ~~`status=0` без эскалации~~ — СДЕЛАНО (24.10): `pcFill()/pcFillAllowed()/escalate()`;
   и `status=6`, и `status=0` идут по лестнице «другой шард → PC-филлер»; при исчерпании —
   сообщение (`pcDone` ⇒ «сервер не принял звук»). `node --check` чисто, сервер отдаёт
   новую версию (`len=49093`), старая ветка `status=6` не тронута по смыслу.
2. ~~E2E на свежем ролике~~ — СДЕЛАНО (24.10, 10:16): два прогона E2E зелёные (см. §4).
3. ~~kick вернул тот же tid~~ — ПОДТВЕРЖДЕНО: совпал в обоих прогонах.
4. `status=0` живьём не воспроизведён — при случае проверить (код-путь общий с 6).
5. ~~`reviewer` → коммит~~ — СДЕЛАНО: ревью нашло гонку (`handleResp` без проверки
   `state.curId`) ⇒ добавлены guard'ы в `handleResp` и `pcFill`; коммит `c051f252940`
   (18 файлов: `dev_server/`, `vot_bridge/`, `STATE.md`, `AGENTS.md`, скрипты; APK/jar/
   dex/логи/`_v_repo`/`Vot*.java`/секреты — в `.gitignore`). Репо — sparse-checkout,
   поэтому новые файлы вне cone добавлять через `git add --sparse`.
6. Осталось как техдолг: корневой `vot.js` (tracked, v2, 449 строк) устарел — живой
   оверлей теперь только `dev_server/vot.js`; решить, удалять ли старый.

## 6. Операционное
- `status`: 1 готово, 2 синтез, 5 частичный (играем), 6 нет звука → филлер, 0 провал.
- Логи ТВ только `adb -s 192.168.1.100:5555 logcat -d -s VotBridge`.
- Dev-сервер: `Start-Process "C:\Program Files\Python311\python.exe" -ArgumentList
  "dev_server\serve_vot.py" …`; `http://127.0.0.1:8013/ping`; `FILL_JOBS` — в памяти.
- Секреты `dev_server/yt_cookies.txt`, `vot_secret.json` — в `.gitignore`.
