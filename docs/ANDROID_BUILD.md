# GitHub Actions: автосборка APK (Android)

CI автоматически собирает приложение и готовит **APK-файл** при каждом пуше в `main`
и при создании тега версии (например `v1.0.0`).

## Как получить APK

1. Зайдите на страницу репозитория → вкладка **Actions**.
2. Откройте последний прогон workflow **«Build Android APK»**.
3. Прокрутите вниз до раздела **Artifacts**.
4. Скачайте архив `app-release` (или `app-debug`) → внутри файл `app.apk`.
5. Передайте файл на телефон (через мессенджер, USB или облако) и установите.
   На телефоне нужно разрешить установку из «неизвестных источников».

## Два способа сборки

| Файл | Способ | Результат | Плюсы |
|------|--------|-----------|-------|
| `.github/workflows/build-apk.yml` | **Capacitor** (рекомендуется) | Полноценное нативное Android-приложение с WebView | Доступ к Bluetooth API нативно, надёжнее |
| `.github/workflows/twa-apk.yml` | **TWA / Bubblewrap** | Обёртка над PWA-сайтом | Минимум кода, обновляется через сайт |

Для TWA нужно опубликовать веб-версию в интернет (GitHub Pages включён в настройках репозитория)
и один раз указать URL в секрете `TWA_APP_URL` (Settings → Secrets and variables → Actions).

## Подпись релиза (опционально, для публикации в Google Play)

Создайте keystore на своём компьютере:

```bash
keytool -genkey -v -keystore release.keystore -alias liion -keyalg RSA -keysize 2048 -validity 10000
```

Добавьте в репозиторий (Settings → Secrets and variables → Actions):
- `KEYSTORE_BASE64` — base64 файла keystore: `base64 release.keystore | pbcopy` (Mac) или через `certutil`/`base64` (Windows/Linux)
- `KEYSTORE_PASSWORD` — пароль keystore
- `KEY_ALIAS` — имя алиаса (`liion`)
- `KEY_PASSWORD` — пароль ключа

После этого workflow будет собирать **подписанный release APK** вместо debug.

## Структура workflow

```
on: push to main / tag v*
  1. checkout
  2. setup node 20 + npm ci
  3. npm run build            # сборка PWA в dist/
  4. npx cap add android      # создание android-проекта (если ещё нет)
  5. npx cap sync
  6. cd android && ./gradlew assembleDebug (или assembleRelease с подписью)
  7. upload artifact app.apk
```
