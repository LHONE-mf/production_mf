# Li-Ion Production — Система управления производством

## Описание

Веб-приложение для управления работами в цеху по производству литий-ионных аккумуляторов. Поддерживает работу как в браузере (включая офлайн-режим), так и в виде APK-приложения на Android.

## Быстрый старт

```bash
npm install
npm run dev      # Запуск в режиме разработки
npm run build    # Сборка для продакшена
```

### Демо-аккаунты

| Роль | Логин | Пароль |
|------|-------|--------|
| Начальник производства | chief | admin123 |
| Мастер цеха | master | master123 |
| Технолог | technologist | tech123 |
| Работник | worker | worker123 |

## Архитектура

### Модули

| Модуль | Путь | Описание |
|--------|------|----------|
| **Core** | `src/core/` | Ядро: типы, БД (IndexedDB), хранилище (Zustand), права доступа |
| **Auth** | `src/modules/auth/` | Авторизация, управление сессиями |
| **Users** | `src/modules/users/` | CRUD сотрудников, назначение ролей |
| **Tasks** | `src/modules/tasks/` | Управление заданиями, статусы, приоритеты |
| **Dashboard** | `src/modules/dashboard/` | Ролевые дашборды с KPI |
| **Communication** | `src/modules/communication/` | Bluetooth, QR-коды, deep links |
| **Sync** | `src/modules/sync/` | Master-Slave синхронизация, Mesh-сеть |
| **Reports** | `src/modules/reports/` | Аналитика, KPI, отчёты |
| **Shared** | `src/shared/` | Общие UI-компоненты, layout |

### Роли и права

```
Начальник производства (Chief)
├── Мастер цеха (Master)
│   ├── Технолог (Technologist)
│   └── Работники (Workers)
```

Каждая роль имеет ограниченный доступ к функциям системы согласно матрице прав.

### Хранение данных

- **IndexedDB** (через Dexie.js) — основное хранилище для офлайн-работы
- **Zustand** — управление состоянием с персистентностью
- Данные синхронизируются между устройствами через Bluetooth Mesh

### Bluetooth Mesh

```
[Master] ←BLE→ [Slave 1] ←BLE→ [Slave 2]
    ↑                              ↑
    └────── [Slave 3] ←BLE→ [Slave 4]
```

- Master может принудительно отправлять данные на Slave
- Slave устройства ретранслируют сообщения
- При потере связи — автономная работа с последующей синхронизацией

## PWA / Офлайн

Приложение работает как Progressive Web App:
- Установка на домашний экран (iOS/Android/Desktop)
- Полная работа без интернета
- Service Worker для кеширования
- IndexedDB для хранения данных

## Android APK

Для сборки APK используется Capacitor или TWA (Trusted Web Activity):

```bash
# Через Capacitor
npx cap add android
npx cap sync
npx cap open android
```

## Технологии

- React 18 + TypeScript
- Tailwind CSS 4
- Zustand (state management)
- Dexie.js (IndexedDB wrapper)
- QR Code (qrcode.react + html5-qrcode)
- Web Bluetooth API
- Vite (build tool)

## Структура модулей (plug-in)

Каждый модуль имеет:
- `components/` — UI-компоненты
- `hooks/` — кастомные хуки
- `services/` — бизнес-логика
- `index.ts` — публичный API

Модули подключаются независимо через barrel exports.
