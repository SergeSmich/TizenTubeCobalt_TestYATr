# STATE — TizenTubeCobalt + Yandex VOT (29.10.2026, ночь)

## Цель
Живые голоса Яндекса (VOT) в TizenTubeCobalt **serverless** (в рантайме API Яндекса + статика GitHub/CDN).
Ветка `fix-vot-runtime-injection`, PR в `main` не делать. История — `STATE_ARCHIVE.md`.
Тест: **`YNDX-00091` (magritte, Android 11, armeabi-v7a) `adb 192.168.1.100:5555`**, пакет
`io.gh.reisxd.tizentube.cobalt` 2.0.3, activity `dev.cobalt.app.MainActivity`.
**SberBox 192.168.1.198 НЕ ТРОГАТЬ** до отдельной команды.

## ✅ Работает на ТВ (проверено, ПК-сервер ВЫКЛЮЧЕН)
- Standalone: `overlay from assets 192692 bytes` → `/ping` 200 → `/config`
  `{"lively":false,"hasToken":false,"audioMode":"capture","pcFill":false}`.
- Бутстрап в `libchrobalt.so` = реф **`v@b003`**: лёгкий загрузчик, грузит оригинальный
  `userScript.js` с CDN и fetch-ит `/vot.js` с моста (127.0.0.1:8013) → eval. Перепрошивать не нужно.
- Авто-перевод без клика (`vot.js:1784` → `startTranslation` на каждом ролике).
- **E2E доказан на НЕкэшированном ролике `Oj8Sz0LQAos`**: `cap begin` → `status=6` →
  `cap uploaded bytes=1230146 itag=140 in 266ms` → `status=2` (rem→0) → `status=1` →
  `play https://vtrans.s3-private.mds.yandex.net/tts/prod/...` → `playback started`.
- **Определение языка без ПК**: `fetchMeta` теперь при `pcFill:false` идёт в `/meta_local`
  (мост, player-ответ, `defaultAudioTrackIndex`) → `meta_local id=… lang=en 836ms`, задержка 17 с ушла.

## 🔴 Грабли: чёрный экран (вылечено)
`am start … -f 0x10008000` при уже работающем приложении убивает surface:
`onVideoSurfaceDestroyed` → `Prepare to suspend` **без resume** → Cobalt навсегда suspend →
`[ERROR:player_create.cc(201)] Video surface is not available now` → SbPlayer не создаётся = чёрный экран,
при этом страница жива (MSE качает), а TTS играет отдельным MediaPlayer моста.
**Правило: не перезапускать activity через `-f 0x10008000`, когда приложение на экране.**
Холодный старт (после install) с `-f 0x10008000` — безопасен.

## ⚠️ Осталось
- **Покрытие**: захват = только проигранное из MSE, обрезка `CAP_MIN 12s / CAP_MAX 45s / 4 МБ`
  (`vot.js:736-741`), `CAP_LIMIT 24 МБ` (`vot_net.js:181`). Полный трек не решён.
- Косметика: при холодном старте `overlay fetch failed` / `config fetch failed` 3×8 с на мёртвый
  `192.168.1.186:8013`, затем backoff 300 с. Не влияет на работу (берутся `assets`), но шумит в логе.
- Без токена Яндекса `lively=false` → обычный голос (токен приходил только с ПК).
- VIEW-интент на холодном старте открывает home, ролик выбирается автоплеем — для тестов
  открывать ссылку после HOME, без clear-task.

## Следующие шаги
1. Ревью (`reviewer`) и коммит рабочего serverless-состояния в `fix-vot-runtime-injection` (не пушить).
2. Полный трек: seek-обход таймлайна (докачка сегментов + склейка) либо явное ограничение обещания.
3. По желанию: тишина в логе при `pcFill:false` (не ходить за config/overlay на ПК при наличии assets).

## Грабли
- `am force-stop`/`kill` запрещены; install APK убивает процесс.
- `adb forward tcp:18114 tcp:8013` для `.100`; старый `18014` принадлежит `.198` — не трогать.
- Логи только `adb logcat -v time -s VotBridge:V` (+`starboard:V cobalt:V` для медиа).
- `Bridge.java` с BOM (`utf-8-sig`); `build_bridge.ps1 -NoInstall` — сборка без установки;
  APK `tt203_bridge.apk` в корне; `assets/vot.js` = `vot_ui.js + vot.js + vot_net.js` (`\n;\n`).
- `curl`/`wget` на ТВ нет: `toybox nc` из `/data/local/tmp` или `adb forward` + Invoke-WebRequest.

## Артефакты
`…\opencode\`: `sa_meta.log` (E2E + meta_local), `sa_install.log`, `sa_e2e.log`, `cap_e2e.log`, `fork_vot_pid.log`.
