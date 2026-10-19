# Comfort Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мобильное удобство: честная PWA, память сессии между открытиями,
действия на треке (лонг-пресс + экран трека с полным toggle лайка), конец
очереди без кражи в волну.

**Architecture:** Architects ничего нового на сервер, кроме открытия unlike;
весь остальной объём — фронт (`public/`) поверх существующих паттернов:
bottom sheet вместо модалок, `localStorage` для сессии, SW поверх статики.

**Tech Stack:** Vanilla JS/ES6-функции как в `app.js`, голый Node `http`,
SW на Service Worker API, no deps.

**Spec:** `docs/superpowers/specs/2026-10-19-comfort-pack-design.md`

## Global Constraints

- Ноль npm-зависимостей; всё vanilla.
- Новый UI: AMOLED — фоновые поверхности `#000`; Material You — bottom sheet,
  радиусы 16–24px, акцент существующий `#ffcc00`.
- Все API-ходки через собственный сервер (`/api/*`); токен только в
  `localStorage` браузера.
- Не ломать Wave: rotor-фидбек (`trackStarted`/`skip`/`radioStarted`) без изменений.
- Стиль коммитов репо: Conventional Commits (`feat:`, `fix:`).
- `.env` и команды с живым токеном в логи/git не попадают.

## Review Focus

1. **Истёкший токен при restore** — восстановленная очередь должна отдать
   гость-режим с превью-плашкой, а не упасть: восстановление не читает
   `oauthToken` для решения показа (токен живёт отдельно), только подставляет.
   → Task 3: тест-шаг «restore без oauthToken».
2. **Повреждённый/усечённый `ym_session:<id>`** — `JSON.parse` в try/catch,
   garbage → тихий пустой старт, без исключений в консоли. → Task 3.
3. **Лонг-пресс vs скролл списка** — отменять открытие sheet'а при
   первом же скролльном `touchmove`; и не открывать при тапе-в-давление.
   → Task 4: код-шаг с порогом `move>10px`.
4. **SW устаревание** — network-first для `index/app/style` + `skipWaiting`,
   иначе после деплоя телефоны на вечном старом коде. → Task 2: тест-шаг
   grep `skipWaiting` в `sw.js`.
5. **Toggle лайка для уже-лайкнутого трека не из Лайков** — состояние из
   `/api/like-status`, повторный клик → `remove=1` → трек исчезает из
   «Мне понравилось». → Task 1: curl-ч成功举办 убедительен цикл add/remove/add.

---

### Task 1: Снятие лайка на сервере (`/api/like` remove)

**Files:**
- Modify: `server.js` (блок `/api/like`, строки ~766–803)
- Test: curl-цикл с живым токеном из `.env` (не попадает в git)

**Interfaces:**
- Consumes: `getAccountInfo(token) -> {loggedIn, user.uid}`, `yandexRequest(url, token, method, body)`,
  `invalidateApiCache(fragment)`.
- Produces: `POST /api/like` с телом `{remove: 1}` →
  `{ok: true, liked: false, status}` — фронт Task 4 вызывает этот же роут.

- [ ] **Step 1: Убрать ранний reject `body.remove` и реализовать remove-ветку**

Замена блока «14 request shapes» (строки ~766–779): для `body.remove` →
`POST https://api.music.yandex.net/users/{uid}/likes/tracks/remove` с
`yandexRequest(url, token, "POST", {})` и query `?track-ids=<id>`
(live-проверка 2026-10-19 подтвердила `result.revision` и фактическое
удаление из библиотеки). Успех = `status===200`;
успех → `invalidateApiCache("/likes/tracks")`. Ответ `{ok:true, liked:false, revision}`.

- [ ] **Step 2: Живо-прове́рить цикл**

Run:
```bash
T=$(grep YM_TOKEN .env | cut -d= -f2)
Q=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$T")
curl -X POST "http://localhost:3457/api/like?token=$Q" -H 'Content-Type: application/json' \
  -d '{"id":"155401527","albumId":"43801468","remove":0}'
curl -X POST "http://localhost:3457/api/like?token=$Q" -H 'Content-Type: application/json' \
  -d '{"id":"155401527","remove":1}'
curl -s "http://localhost:3457/api/like-status?token=$Q&ids=155401527"
```
Expected: первый `{ok:true,...}`, второй `{ok:true,liked:false,...}`, третий
`{"likedIds":[]}`. Последний лишний like не остаётся (след тестов чист).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: unlike works via /likes/tracks/remove (verified live)"
```

### Task 2: Честная PWA (manifest + icons + sw)

**Files:**
- Create: `public/manifest.json`
- Create: `public/icon.svg` (плоская жёлтая молния на чёрном, `sizes:"any"`)
- Create: `public/sw.js`
- Modify: `public/index.html` (link manifest + `<meta name="apple-touch-icon">` не вводим)
- Modify: `public/app.js` (регистрация SW в самом конце файла)
- Test: `node --check public/sw.js`, curl статик

**Interfaces:**
- Produces: `sw.js` самостоятельный; `app.js` вызывает
  `navigator.serviceWorker.register("/sw.js")` только на https/localhost;
  манифест `name: "Яндекс Музыка Web Mod"`, `short_name:"ЯМ Мод"`,
  `background_color:"#000000"`, `theme_color:"#000000"`, `display:"standalone"`,
  `icons: [{src:"/icon.svg", sizes:"any", type:"image/svg+xml", purpose:"any"}]`.

- [ ] **Step 1: `public/manifest.json`** — значения, как в Interfaces (точные строки).
- [ ] **Step 2: `public/icon.svg`** — SVG 512x512: rect `#000`, path молнии
  `#ffcc00`; `<viewBox="0 0 512 512">`; молния примерно из точек
  `300 64→160 320→256 320→212 448→384 192→288 192→330 64` (строитель поправит
  пропорции).
- [ ] **Step 3: `public/sw.js`** — const `CACHE="ym-shell-v1"`;
  precache `["/","/index.html","/style.css","/app.js","/manifest.json","/icon.svg"]`;
  fetch-handler: только GET; `/api/` → сеть всегда (pass-through, без кеша);
  иначе network-first с кеш-фолбэком и заполнением кеша успешными ответами;
  `install` → `skipWaiting()`, `activate` → `clients.claim()` + удаление старых
  `ym-shell-*`.
- [ ] **Step 4: `public/index.html`** — между двумя `<link rel="stylesheet">`:
  `<link rel="manifest" href="/manifest.json">` и
  `<meta name="theme-color" content="#000000">` (замена существующего `#121212`).
- [ ] **Step 5: регистрация в `app.js`** — последний блок:
  `if ("serviceWorker" in navigator && /^https:$/.test(location.protocol) || location.hostname==="localhost") navigator.serviceWorker.register("/sw.js").catch(()=>{});`
  (точный оператор priority: `(https || localhost)` — строитель оформит скобки).
- [ ] **Step 6: проверить**

Run: `node --check public/sw.js && curl -s localhost:3457/manifest.json | head -3 && curl -s -o /dev/null -w "%{http_code}" localhost:3457/icon.svg && curl -s -o /dev/null -w "%{http_code}" localhost:3457/sw.js`
Expected: JSON-ответ, для последующих `200 200`, синтаксис без ошибок.

- [ ] **Step 7: Commit**

```bash
git add public/manifest.json public/icon.svg public/sw.js public/index.html public/app.js
git commit -m "feat: real PWA (manifest, icon, network-first SW)"
```

### Task 3: Память сессии (`ym_session:<token>`)

**Files:**
- Modify: `public/app.js` (вставки: state-block после `playReport`; хуки
  `playTrack`, `playNext`, существующий `timeupdate`, `settingsLogoutBtn`
  НЕ трогаем — сессия уходит вместе с ключом-токеном; блок restore после
  инициализации `oauthToken`)
- Test: `node --check public/app.js` + функционал на живом UI

**Interfaces:**
- Consumes: `getToken()`, существующие переменные `queue`, `queueIndex`,
  `radioSessionId`, `playedTrackIds`, `currentTrack`, `audio`.
- Produces:
  - `tokenKey()` -> `ym_session:` + первые 12 hex `sha256(oauthToken)`
    (`crypto.subtle` недоступен в http: fallback — сам строковый токен,
    обрезанный до 20 симв.) — cпецификация только имён; строитель выбирает
    внутри указанных допущений.
  - `saveSession()` — сериализует `{ v:1, queue (слайс 100: id,title,artists,
    album,albumId,coverUri,durationMs, durationMs→ms-int), queueIndex,
    radioSessionId, source, playedTrackIds (cap 200), trackId/token-фрагмент }`;
    вызывается в `playTrack` (после установки `currentTrack`),
    в `playNext`/`playPrev` после смены индекса.
  - `savePosition()` — тром в `timeupdate` раннее существующего
    `accumulatePlayTime()`, не чаще 1р/5сек: `audio.currentTime`.
  - `restoreSession()` — при загрузке: parse try/catch; очередь → `queue`,
    индекс, радиосессию; НЕ автостарт; мини-плеер `updateTrackUI(...)` в
    состоянии пауза (`setPlayState(false)`), прогресс `savePosition()-время`.
    Экспоуз SOURCE-манифест restored: source отражён в топонимике волны
    («Продолжаем: <источник>») — заголовок `waveTrackTitle` неписан до play.
- [ ] **Step 1: state-block** (tokenKey/saveSession/savePosition/restoreSession) — тела по Interfaces.
- [ ] **Step 2: hooks** — вставки вызовов saveSession×3 + savePosition в timeupdate.
- [ ] **Step 3: restore-блок** — после проверок токена (строка ~430): если
  сессия есть и queue.length>0 → восстановить + мини-плеер «пауза» + подпись
  источника на экране волны; при `oauthToken` отсутствии — тоже восстановить
  (гость-режим обрабатывает обычная плашка).
- [ ] **Step 4: проверить**: `node --check public/app.js` → OK; на живом UI:
  играть трек → перезагрузить страницу → мини-плеер показывает трек
  в паузе на сохранённой позиции, тап play продолжает с места.
- [ ] **Step 5: Commit**
```bash
git add public/app.js
git commit -m "feat: session memory (queue/position per token, silent restore)"
```

### Task 4: Действия на треке (bottom sheet) + экран трека + конец очереди

**Files:**
- Modify: `public/app.js` (хелперы: long-press, sheet UI, state-подменa
  `playNext`-fallback, обёртки открытекарточки)
- Modify: `public/index.html` (один контейнер sheet-ноды + разметка плашки конца очереди)
- Modify: `public/style.css` (блоки: `.track-sheet`, `.sheet-backdrop`,
  `.sheet-actions`, AMOLED-InOut: `#000`, radius 24px top)
- Test: `node --check public/app.js`; UI-прогон по шагам проверки

**Interfaces:**
- Consumes: `POST /api/like` (Task 1: `{remove:0|1}`), `GET /api/like-status`
  (сущ.), `queue`/`queueIndex`, `playTrack`, `likedIds`/`likesDirty`.
- Produces:
  - `openTrackSheet(track, {fromList})` — sheet с: обложка/описание/фолбэк
    `FALLBACK_COVER`; строки «артисты · альбом · mm:ss»; сердце с состоянием
    из `trackIdLiked`/batch; кнопки: Лайк/Убрать лайк → `(fetch /api/like)
    {remove: liked?1:0}`, меняет `likedIds` и `likesDirty=true`; «Следом» —
    `queue.splice(queueIndex+1,0,track)` (в wawe — только toast «В волне
    очередь ведёт Яндекс»), «Слушать» — радиосессия off → `queue=[track]`
    выглядит как источники «search» — играть; затем закрыть.
  - Лонг-пресс: у списков из `renderTrackList` вешается `pointerdown` (touch
    only) с `setTimeout(400)`; отмена на `touchmove`>10px, `pointerup` и
    `contextmenu`-prevent;
    в `playing`-реж👗 long-press тоже работает (текущий трек).
  - Тап по инфо-зоне мини-плеера → `openTrackSheet(currentTrack)`;
    за исключением кнопок/прогресса.
  - **Конец очереди:** в `playNext()` fallback (else-ветка, `/api/wave`
    не задействован) — НЕ `startWave()`, а экран `waveEnded()`: зона волны
    показывает плешку «Очередь закончилась» + кнопка «Включить Мою Волну»
    (→ `startWave()` по нажатию). Для `radioSessionId` путь без изменений.
- [ ] **Step 1: разметка sheet'а + плашки** в `index.html` (по Interfaces).
- [ ] **Step 2: CSS-блоки** в `style.css` (AMOLED-sheet: `#000` фон, отбросить
  цветные тени, radius 24px top-цвета).
- [ ] **Step 3: JS** — `openTrackSheet` + actions + лонг-пресс + мини-плеер +
  `waveEnded()`; подмена fallback в `playNext` (одна строка: вызов `waveEnded()`).
- [ ] **Step 4: проверить**: `node --check public/app.js` → OK; UI-прогон:
  лонг-пресс в Поиске → sheet; toggle сердцем → в Лайках трек появился/исчез
  после refresh; «Очередь закончилась» — плейлист из 1 трека, доиграл →
  плашка, волну не запускали; при волне — прежнее поведение продолжения.
- [ ] **Step 5: Commit**
```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat: track actions sheet (like toggle) + track view + honest queue end"
```

### Task 5: Скатка AMOLED по новым поверхностям

**Files:**
- Modify: `public/style.css` — только что-созданные Task 4 классы и sheet-фон;
  глобальные тёмные темы НЕ отрываем (не отсылаем существующий UX в «чёрный
  дыр»-дизайн с системными панелями — только новые поверхности).
- Test: визуальный прогон на телефоне/eMMU-ширине

- [ ] **Step 1: sheet/плашка/листки стандартизованы на `#000` + радиусы 24px,
  акцент `#ffcc00` не меняется.**
- [ ] **Step 2: Commit**
```bash
git add public/style.css
git commit -m "style: AMOLED surfaces for comfort pack"
```

## Self-Review

Spec-покрытие: PWA/СW → Т2; память → Т3; действия+экран+конец → Т4;
unlike-сервер → Т1; AMOLED → Т5. Обновления SW-устаревания — Review Focus 4,
grep-тест в Т2. RSS-плешки: Tests-шаге в каждом Task явные строки.
Step-scan: шаги — по одному действию (строки кода описаны Interfaces/значениями,
не транскрипт). Имена последовательны: `openTrackSheet`, `saveSession`,
`tokenKey`, `waveEnded`.
Обновляемая пропорция: план не превышает код (тела кодовых кусков заданы семантикой).
