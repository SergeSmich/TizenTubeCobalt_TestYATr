---
id: L-0001
title: Аудит определения языка оригинала и окон HOLD
from: opencode
to: arena
kind: task
status: closed
branch: local/opencode
needs: none
---

## Задача
Статический аудит определения языка оригинала и окон HOLD.
Файлы: `dev_server/vot.js`, `vot_bridge/java/vot/Bridge.java`,
`dev_server/vot_net.js`. Нужен список конкретных дефектов с `файл:строка`
и минимальными патчами (diff). Ничего не запускать.

## Контекст
- Правила проекта: «unknown beats wrong»; HOLD показывается только когда
  опрос меты реально исчерпан; пока идёт опрос — окно «определяю язык
  звука…» (`state.metaPending`); `defaultAudioLanguage` — язык дубля, не
  оригинала; ранги `/source`: job(4) > track(3) > default(2) > page(1);
  `skipLang` по умолчанию `ru`.
- Ключевые функции JS: `fetchMeta`, `fetchMetaLocal`, `langWaitStatus`,
  `langHoldText`, `showLangHold`, `maybeSkipNow`, `trackDecision`,
  `holdPending`, `focusOwnsKey`, `startTranslation`, `toggleTranslate`,
  `isTranslateOn`.
- Мост: `fillLang`, `originalFormatLang`, `audioFormatLang`, `xtagsText`,
  `publishSource*`, `sabrParamsFromCfg`, `roleOfName`.
- Уже исправлено (не предлагать заново): formats читаются из
  `streamingData`; `dubbed` ищется в декодированном `xtags`; `metaPending`
  ставится в начале `fetchMeta` и на каждом ретрае (25 с, цепочка 45 с);
  OK не перехватывается при фокусе на контроле (`FOCUS_CTRL`).

## Вопросы (ответить по каждому)
1. Гонки `metaPending` / `langWaitForId`: есть ли путь, где окно навсегда
   остаётся «определяю язык звука…» (сеть упала, поздняя цепочка не
   стартовала, `curId` сменился)? Перечислить все места установки и снятия
   флагов, предложить гарантированный таймаут/`finish`.
2. `forceTranslate` после OK: если потом приходит `meta_local lang=ru`,
   правильно ли, что перевод не отменяется? Сверить `maybeSkipNow`,
   `isTranslateOn`, `resetSession`.
3. `focusOwnsKey` / `FOCUS_CTRL`: покрывает ли список все фокусируемые
   элементы Tizen YouTube (плейлист, чипы, настройки, seek bar)? Указать
   дыры, где OK либо перехватывается зря, либо не перехватывается.
4. `setTimeout` поздних ретраев: все ли ветки проверяют `state.curId`?
   Найти те, что могут записать язык старого ролика в новый.
5. `trackDecision` и ранги: возможен ли случай, когда запись `job` без
   языка (`dubStripped=1`) перекрывает корректный `track` и даёт unknown
   там, где язык известен?

## Критерий готовности
`collab/arena/A-0001-*.md`: по каждому пункту — `файл:строка`, что не так,
минимальный diff, риск. Не больше 3 страниц. Без общих рассуждений.

## Ограничения
Не трогать бинарники и APK. Не переписывать архитектуру — только точечные
правки. Не предлагать решения, требующие ПК, adb или доступа к устройству.
