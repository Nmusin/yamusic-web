# AGENTS.md — Единый гайдлайн агентов для yamusic-web

Этот файл задаёт правила архитектуры, размещения кода, обязательные ритуалы проверки и инварианты, которые ни один агент не имеет права нарушать.

---

## 1. Карта репозитория

Архитектура разделена на небольшие модули без сборщиков (Vanilla JS): CommonJS на бэкенде, ES Modules на фронтенде.

### Бэкенд (Node.js CommonJS)

| Файл | Назначение / Роуты | Особенности |
|---|---|---|
| `server.js` | Bootstrap HTTP-сервера, раздача статики, ROUTES-карта | Тонкий диспетчер (~170 строк), не содержит бизнес-логики |
| `lib/yandex.js` | `yandexRequest`, `httpsPostForm`, `generateSign`, headers | DNS `family: 4`, HMAC-SHA256 подпись запросов к Яндексу |
| `lib/cache.js` | In-memory кэш API/аккаунтов, `invalidateApiCache`, `tokenHash` | Кэш с TTL, изоляция по хэшу токена |
| `lib/auth.js` | Авторизация: `resolveToken`, `DEFAULT_TOKEN`, env-токены | `resolveToken(token)` возвращает `string` (токен или гость) |
| `routes/auth.js` | `/api/auth/device-code`, `/api/auth/device-token`, `/api/auth/password` | OAuth Device Code flow и парольная авторизация |
| `routes/wave.js` | `/api/wave`, `/api/rotor/feedback` | **Единственное место** для Rotor-фидбека |
| `routes/likes.js` | `/api/likes`, `/api/like`, `/api/like-status` | Мутации лайков инвалидируют кэш через `invalidateApiCache` |
| `routes/music.js` | `/api/search`, `/api/playlists`, `/api/playlist-tracks`, `/api/smart-playlists` | Поиск, работа с плейлистами и персональными подборками |
| `routes/stream.js` | `/api/stream`, `/api/quality-test` | AES-CTR расшифровка потока, поддержка 206/200 Range, тест битрейтов |
| `routes/account.js`| `/api/account`, `/api/play-audio`, `/api/cache-stats` | Профиль, отчёт о прослушивании (`sendBeacon`/fetch), статистика кэша |

### Фронтенд (`public/` ES Modules)

| Модуль | Назначение |
|---|---|
| `public/index.html` | Единственная точка входа UI (`<script type="module" src="/js/main.js"></script>`) |
| `public/package.json` | `{"type": "module"}` для поддержки `node --check` в ES-модулях |
| `public/sw.js` | Service Worker (кэш оболочки `ym-shell-v3`, network-first для статики, bypass для `/api/*`) |
| `public/js/state.js` | `export const state = { ... }` — единый мутабельный объект состояния |
| `public/js/dom.js` | Кэширование ссылок на DOM-элементы (`document.getElementById`) |
| `public/js/util.js` | `formatSecs`, `formatDuration`, `FALLBACK_COVER`, всплывающий `toast` |
| `public/js/api.js` | Тонкие обёртки запросов к API: `jsonFetch`, `apiGet`, `apiPost` |
| `public/js/session-memory.js` | Хранение токена и молчаливое сохранение/восстановление сессии (`ym_session:<hash>`) |
| `public/js/audio-engine.js` | Управление `<audio>`, воспроизведение `playTrack`, отчёты `play-audio`, Rotor-фидбек |
| `public/js/wave.js` | Непрерывная загрузка и запуск Моей Волны (`startWave`, `fetchMoreWaveTracks`) |
| `public/js/likes-core.js` | Логика лайков/дизлайков (`likeTrack`), синхронизация сердец на всех экранах |
| `public/js/tracks-lists.js` | Рендеринг списков треков, поиск с debounce/AbortController, плейлисты, подборки |
| `public/js/track-sheet.js` | AMOLED-шторка действий с треком (лонг-пресс в списках и мини-плеере) |
| `public/js/player-screen.js` | Полноэкранный плеер с перемоткой полосой (drag scrubbing) |
| `public/js/media-session.js` | MediaSession API для экрана блокировки Android и Bluetooth-гарнитур |
| `public/js/nav.js` | Переключение табов, горячая клавиша Space (Play/Pause) |
| `public/js/auth.js` | Модалка входа (Device Code / пароль / токен), профиль пользователя |
| `public/js/pwa.js` | Регистрация Service Worker (`/sw.js`) |
| `public/js/main.js` | Bootstrap приложения, таймер сна, тестирование битрейта |

---

## 2. Правила размещения кода

- **Новый API-роут**: создаётся/добавляется в соответствующий `routes/<домен>.js`, регистрируется в объекте `ROUTES` в `server.js`.
- **Новая фича интерфейса**: размещается в соответствующем модуле `public/js/` (или создаётся новый модуль), импортируется в `main.js`.
- **Лимит на размер**: ни один JS-файл не должен превышать ~400 строк.
- **Без бандлеров и транспайлеров**: чистый Vanilla JS (Node.js 20+ на бэке, ESM в браузере).

---

## 3. Инварианты, которые нельзя ломать

1. **Rotor-единственность**: фидбек ротора на бэкенде живёт **только** в `routes/wave.js`, на фронтенде — в `audio-engine.js` (`sendRotorFeedback`).
2. **Инвалидация кэша**: любые мутации лайков (добавление, удаление) обязаны вызывать `invalidateApiCache(token)` в блоке успеха.
3. **Wave-автопродолжение**: `showWaveEnded()` показывается только если `radioSessionId === null` (вне волны). В волне треки запрашиваются непрерывно.
4. **family: 4 (IPv4)**: во всех сетевых исходящих запросах к Яндексу (`yandexRequest`, `httpsPostForm`, `https.request`) строго задаётся `family: 4` (IPv6 в среде egress мёртв).
5. **Form-urlencoded**: POST-запросы к API Яндекса требуют `Content-Type: application/x-www-form-urlencoded` и подпись `generateSign`.

---

## 4. Ритуал проверки (Self-Check Ritual)

Перед любым коммитом обязательны следующие шаги:
```bash
# 1. Синтаксическая проверка всех файлов
node --check server.js lib/*.js routes/*.js public/sw.js public/js/*.js

# 2. Запуск тестового сервера (порт 3459, не занимать прод-порт 3000!)
PORT=3459 node server.js &
PID=$!

# 3. Смоук-тест статики и API
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3459/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3459/js/main.js
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3459/api/account
kill $PID
```
После изменений фронтенда — контрольная приёмка на телефоне по чек-листу D5.

---

## 5. Git-правила

- Формат коммитов: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`).
- **Никогда не коммитить**: `.env`, `tasks.do_not_push_this.txt`, `TASKS.txt`.
- Работа ведётся в фиче-ветках или worktree, слияние в `master` производится только после полной проверки.

---

## 6. Платформенные ловушки среды

- **IPv6-AAAA не работает в egress**: всегда указывать `family: 4` в сетевых опциях Node.js.
- **MediaSession в шторке Android**: Chromium bug 40287871 — полоса воспроизведения и ±10 сек могут не отображаться в некоторых версиях Android, это нормальное поведение платформы.
- **PRoot / Termux**: открытые перезаписываемые файлы могут блокироваться; для безопасной замены использовать атомарные операции.
- **`node --check` для ESM**: в каталоге `public/` лежит `package.json` с `{"type": "module"}`, что позволяет Node проверять ES-модули без ошибок синтаксиса.

---

## 7. AMOLED Дизайн-токены

- Фон: истинный черный `#000000` (AMOLED).
- Поверхности карточек/панелей: `#111111`, `#181818`, `#222222`.
- Скругления: `border-radius: 24px` для модалок и шторки, `12px`-`16px` для карточек.
- Акцентный цвет: желтый Яндекс Музыки `#ffcc00`.
- Паттерн для второстепенных действий: всплывающая снизу шторка (bottom sheet).
- Запрет на тяжелые тени и градиенты, расходующие батарею на OLED-экранах.

---

## 8. Правило бампа SW-кэша

При любом изменении файлов внутри `public/` (JS, CSS, HTML, иконки):
1. Обязательно поднять версию кэша в `public/sw.js`:
   ```javascript
   const CACHE = "ym-shell-v4"; // инкремент версии
   ```
2. Если добавлены новые JS-модули, включить их пути в массив `PRECACHE` в `public/sw.js`.
Без этого телефоны продолжат открывать устаревшую версию из кэша.

---

## 9. Top-Level правило модулей (Защита от циклов)

В ES-модулях `public/js/*.js`:
- **Запрещено** вызывать экспортированные функции из других модулей на верхнем уровне (в теле модуля при загрузке).
- Любые межмодульные вызовы производятся **исключительно внутри функций-обработчиков или обработчиков событий**.
Это гарантирует отсутствие ошибок циклических зависимостей (TDZ) при загрузке графа.

---

## 10. Инвентарь ключей localStorage

Используются строго следующие ключи (переименование запрещено):
- `ym_token`: сохраненный OAuth-токен пользователя.
- `ym_user`: кэшированный JSON профиля пользователя для мгновенной отрисовки.
- `ym_quality`: выбранное качество звука (`lq`, `nq`, `hq`).
- `ym_session:<sha256(token)>`: сохраненная сессия (очередь, текущий трек, позиция проигрывания).

---

## 11. Канонический шаблон роут-хендлера

Каждый хендлер в `routes/*.js` имеет сигнатуру:
```javascript
module.exports = async function handler(req, res, ctx) {
  const { query, resolveToken, parseBody, yandexRequest, yandexCached, invalidateApiCache } = ctx;
  const token = resolveToken(query.token);
  // ... проверка guard / parseBody ...
  // ... логика / обращение к Яндексу ...
  // при успешных мутациях лайков:
  // invalidateApiCache(token);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
};
```
