# Исправление деплоя Worker на Render.com

## Проблема: Worker не видит деплоев

Если Worker на Render.com не обновляется автоматически, проверьте настройки.

## Решение 1: Проверьте настройки деплоя в Render.com

1. Откройте [Render.com Dashboard](https://dashboard.render.com)
2. Найдите ваш Web Service (например, `chatbot-tg` или `afisha-bot-worker`)
3. Перейдите в **Settings** → **Build & Deploy**

### Проверьте следующие настройки:

#### 1. Source
- **Repository:** должен быть подключен `yummspb13/chatbot_tg`
- **Branch:** `main` (или ваша рабочая ветка)
- **Root Directory:** ⚠️ **ВАЖНО!** Должно быть `worker` (не пусто!)

#### 2. Build Command
```
npm install && npm run build
```

#### 3. Start Command
```
npm start
```

#### 4. Auto-Deploy
- ✅ **Auto-Deploy:** должен быть включен
- ✅ **Pull Request Previews:** можно включить (опционально)

## Решение 2: Запустите деплой вручную

Если автоматический деплой не работает:

1. В Render.com Dashboard → ваш Web Service
2. Нажмите **Manual Deploy** → **Deploy latest commit**
3. Дождитесь завершения деплоя (обычно 2-3 минуты)

## Решение 3: Проверьте Root Directory

**Самая частая проблема:** Root Directory не указан или указан неправильно!

1. В Render.com Dashboard → Settings → Build & Deploy
2. Найдите поле **Root Directory**
3. Убедитесь, что указано: `worker` (без слеша в конце)
4. Сохраните изменения
5. Запустите Manual Deploy

## Решение 4: Проверьте файл render.yaml

Если используете `render.yaml` для автоматической настройки:

1. Убедитесь, что файл `worker/render.yaml` существует
2. Проверьте, что в нем указан `rootDir: worker`
3. Если файл изменен, закоммитьте и запушьте:
   ```bash
   git add worker/render.yaml
   git commit -m "Update render.yaml"
   git push origin main
   ```

## Решение 5: Пересоздайте сервис (если ничего не помогает)

Если настройки не помогают, можно пересоздать сервис:

1. В Render.com Dashboard → ваш Web Service
2. Settings → **Delete Service** (⚠️ сохраните Environment Variables!)
3. Создайте новый Web Service:
   - **Name:** `afisha-bot-worker`
   - **Repository:** `yummspb13/chatbot_tg`
   - **Branch:** `main`
   - **Root Directory:** `worker` ⚠️
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** `Starter` ($7/месяц) - НЕ Free!
4. Добавьте все Environment Variables заново
5. Запустите деплой

## Проверка после исправления

После исправления настроек проверьте:

1. **Логи деплоя:**
   - В Render.com Dashboard → ваш Web Service → Logs
   - Должно быть: `npm install`, `npm run build`, `npm start`

2. **Health check:**
   ```bash
   curl https://chatbot-tg.onrender.com/health
   ```
   Должен вернуть: `{"status":"ok","timestamp":"..."}`

3. **Статус Worker:**
   ```bash
   curl https://chatbot-tg.onrender.com/runner/status
   ```

## Важные моменты

- ⚠️ **Root Directory:** обязательно `worker` (не пусто, не `.`, не `/worker`)
- ⚠️ **Instance Type:** должен быть `Starter` или выше (Free засыпает)
- ⚠️ **Build Command:** должен быть `npm install && npm run build`
- ⚠️ **Start Command:** должен быть `npm start`

## Если деплой все еще не работает

1. Проверьте логи в Render.com Dashboard → Logs
2. Убедитесь, что нет ошибок сборки
3. Проверьте, что файл `worker/package.json` существует
4. Убедитесь, что `worker/src/index.ts` существует
5. Проверьте, что все зависимости установлены

