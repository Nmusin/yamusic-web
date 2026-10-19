# De-god: архитектура yamusic-web + единый агентский гайдлайн

Дата: 2026-10-19 · Статус: утверждён (билдер-чек GO-WITH-FIXES, фиксы встроены)
Автор проектирования: агент (все design-решения — его, отмечены) · Владелец: Nmusin

## Intent и почему

Репо уже вытянуло 8 фич-коммитов за один день; каждый следующий агент читает
`app.js` (1995 строк) и `server.js` (1198 строк) целиком; высок риск: правка
в одном блоке ломает соседний через общие топ-левель-переменные. Владелец
слушает только с телефона, принимает фичи по ходу — значит, каждый
следующий заход агента должен быть дешёвым по чтению и безопасным по записи.
Цель: маленькие файлы с ясными границами + один `AGENTS.md` в корне,
который предписывает каждому агенту, куда класть код и как его проверять.

## Goals

- G1: ни один JS-файл не длиннее ~400 строк; каждый экспортирует понятный кусок.
- G2: `AGENTS.md` в корне репо — единственный гайдлайн агентов (карта
  архитектуры, куда что класть, ритуалы проверки, форбидены).
- G3: нулевая смена поведения. После резки: тот же UI, те же порты/пути,
  тот же PWA, Wave не сломан, `.env`/токен нетронуты.
- G4: без npm-зависимостей и без build-степа (как было). Мин Node 20
  (решение билдера: `node --check` переваривает ESM в `.js` без manifest).

## Non-goals / анти-goals

- Никаких новых фич в этом рефакторинге (даже мелких).
- Никаких npm/бандлеров/TS. Vanilla остаётся vanilla.
- `style.css` НЕ режется в этом проходе (решение возлюбленное: низкий риск,
  высокий шум diff'а — отдельный заход, если надоест).
- Lazy-load ПО ВКЛАДКАМ НЕ делаем (решение владельца: грузим все модули сразу;
  12 модулей суммарно — это те же байты, что были одним app.js).
- Не трогаем: `.env`, `tasks.do_not_push_this.txt`, `docs/superpowers/`.

## Центральные дизайн-решения (все мои, владелец указал только порядок)

### D1: Frontend — ES modules, без сборки

`public/app.js` разрезается в `public/js/<домен>.js` + `public/js/main.js`:

| Модуль | Забирает из app.js | Экспортирует |
|---|---|---|
| state | статус токена/аккаунта, queue, currentTrack, isPlaying, likes-сеты и флаги (likesData/likesLoaded/likedIds/likesDirty), quality | `export const state = {...}` — один мутабельный объект + точечные сеттеры (решение билдера: не геттер/сеттер на каждую переменную, у ESM `let`-байндинги изнутри читаются, но не присваиваются извне) |
| api | все fetch-обёртки `/api/*`, auth-вызовы | api.* |
| audio-engine | `<audio>`, playTrack/playNext/playPrev, rotor-отчёты (sendPlayReport) | engine.* |
| wave | startWave/waveEnded/след-превью | wave.* |
| likes-core | likeTrack, likeStatus-батч, сердца | likes.* |
| tracks-lists | renderTrackList, поиск/плейлисты/подборки-списки, long-press утилита | lists.* |
| track-sheet | шторка действий (Task 4) | sheet.* |
| player-screen | полный экран плеера | playerScreen.* |
| session-memory | ym_session:<hash> | session.* |
| media-session | MediaSession + setPositionState | mediaSession.* |
| pwa | SW-регистрация | — (side-effect) |

`main.js` — единственный скрипт в `index.html`:
`<script type="module" src="/js/main.js">`. Порядок bootstrap:
state → session-restore (молча) → auth → wiring → DOM-слушатели.

**Почему ESM, а не пачка классических скриптов:** классические зависят от
порядка `<script>`-тегов и топ-левель имён (та же божественность, просто
в нескольких файлах); ESM заставляет явные границы, а SW уже
network-first — precache список просто дополняется файлами.
Риск WebView Android минимален: ES-модули поддерживаются Chrome 61+,
PWA и так требует современного Chromium. Факты кода: в index.html
один `<script src="app.js">` (строка 491), ноль inline-скриптов, ноль
`onclick=`-атрибутов — флип это одна правка строки.

### D2: Backend — CommonJS-роуты по доменам

`server.js` → bootstrap + модули:

```
server.js            (~120 строк): createServer, static, dispatch
lib/yandex.js        yandexRequest, httpsPostForm, generateSign, header-констаты
lib/cache.js         apiCache/accInfoCache/downloadInfoCache + invalidateApiCache + tokenHash
lib/auth.js          device-code, device-token, password, resolveToken
routes/wave.js       /api/wave, /api/rotor/feedback (rotor-фидбек только здесь)
routes/likes.js      /api/like(+remove), /api/like-status, /api/likes
routes/music.js      /api/search, /api/playlists, /api/playlist-tracks, /api/smart-playlists
routes/stream.js     /api/stream (range/декрипт), /api/quality-test
routes/account.js    /api/account, /api/play-audio, /api/cache-stats
```

(правка билдера: `/api/auth/device-token`, server.js:290, отнесён в lib/auth.js.)

Диспатчер: map pathname → handler(req, res, ctx); ctx несёт helpers.
Инварианты сохраняются: rotor-фидбек одним местом, invalidateApiCache
после мутаций лайков, form-urlencoded для Yandex, family:4 (уже привито
в yandexRequest — переносится как есть).

### D3: AGENTS.md (гайдлайн агентов) — содержание

1. Карта репо (обе таблицы выше + «где живёт каждая фича»).
2. Правила размещения: новый роут → `routes/<домен>.js` + строка в диспатче;
   новая фича UI → свой модуль в `js/`, импорт в main.js; бан на «файлы > 400 строк».
3. Инварианты, которые нельзя ломать: rotor-фидбек; invalidate-кеш при
   мутациях лайков; wave-автопродолжение (showWaveEnded только при
   radioSessionId===null); family:4; form-urlencoded; family:4/DNS не
   агностичны (в этой среде презедневой egress кончается на AAAA).
4. Проверка-ритуал: `node --check` на тронутых файлах; `PORT=3459 node
   server.js` + curl-смок (порт 3000 занят живым сервером); после фронт-флипа —
   полный телефон-чеклист из 7 пунктов (дефолт ниже).
5. Git-правила: Conventional Commits; никогда не коммитить `.env`,
   `tasks.do_not_push_this.txt`; не пушить в master без явного блага
   владельца (worktree-стайл или Native по решению).
6. Платформенные ловушки среды: IPv6-AAAA мертвы в egress — не писать
   агностичные DNS-клиенты, семейность 4; MediaSession в Android-шторке —
   Chromium bug 40287871 (полоса/±10 не показываются, это ожидаемо,
   не «сломано»); PRoot/Termux: old-файл не перезаписываемый, менять через
   mv+cp; apt может зависнуть долгим — не блочить.
7. Дизайн-токены AMOLED: `#000` поверхности, радиус 24px, акцент `#ffcc00`,
   bottom sheet-паттерн для второстепенных потоков; никаких новых тёней.
8. **Правило бампа SW-кеша** (добавлено по чеку): тронул файл в `public/` →
   бампь `CACHE` в public/sw.js (`ym-shell-v3` и далее). Без этого
   телефоны едят stale-оболочку.
9. **Top-level-правило модулей** (добавлено по чеку): в модуле нельзя
   вызывать чужие функции на top-level импорта — только внутри
   хендлеров/async. Обходит круговые импорты без порчи (все кросс-вызовы
   в app.js уже из хендлеров — 81 addEventListener).
10. **Инвентарь localStorage-ключей** (добавлено по чеку): `ym_quality`,
    `ym_user`, `ym_session:<sha256(token)>`; переименовывать нельзя, владелец —
    соответствующий модуль.
11. **Канонический шаблон хендлера** (добавлено по чеку):
    `resolveToken(req)` → `parseBody(req)` → домен-helpers из ctx →
    `res` JSON; мутации лайков — не забыть `invalidateApiCache` в блоке
    успеха. Одна строка-«шаблон» в AGENTS.md, чтобы новый роут всегда
    следовал одному течению.

### D4: Последовательность миграции (порядок важен, правка билдера)

1. Backend-резка первой (сервер легчё фронта в тесте; curl-проверяемо;
   после каждого коммита: `node --check server.js lib/*.js routes/*.js`
   + запуск магазина PORT=3459 и curl-смок на тронутых роутах).
2. Frontend-резка: коммиты-резки создают модули ПОСЛЕДОВОТЕЛЬНО, при
   index.html всё ещё грузит старый app.js (новые модули — мёртв код,
   смок гоняет старый фронт; это OK и за ранее честно).
   Каждый коммит: `node --check public/js/*.js` + смок старого фронта.
3. Один коммит «флип»: `index.html` → `type="module"` + `sw.js` →
   `ym-shell-v3` + precache expands. После него — полный смок нового
   фронта + телефон-чеклист (7 пунктов).
4. Удаление `public/app.js` (после успеха п.3).
5. `AGENTS.md` пишется последним, когда карты уже реальные.

### D5. Телефон-чеклист приёмки (дефолт билдера, утверждён владельцем как база)

1. Волна: старт, играет, кнопки патруля (лайк/дислайк/скип) отвечают.
2. Лайк/unlike: из шторки доиграл цикл add→remove→add, в «Мне понравилось» появления/исчезновения.
3. Шторка: лонг-пресс на треке в Поиске открывает; «Следом» играет дальше.
4. Полный экран плеера: открывается с мини-плеера тапом, drag-полоса, ±10/стоп.
5. Смарт-плейлисты: вкладка отдаёт сетку, тап играет.
6. Рестарт сессии: перезагрузка страницы → мини-плеер предлагает трек в паузе на позиции.
7. Офлайн-фолбэк: «Самолёт-режим» на странице главная открывается cached-оболочкой (SW).

## Risks

- Chrome-модули в старом WebView — минимально (PWA и так его требует).
- Забытый global при переезде (TDZ/undefined) — ловим node --check +
  живой смок на каждый коммит; regression-паяльник: телефон-чеклист D5.
- Push-мерж в момент работ: работа в worktree на ветке, merge по согласию.
