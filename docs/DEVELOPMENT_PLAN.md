# План разработки: Система управления производством Li-Ion аккумуляторов

## Архитектура

### Модульная структура (Plug-in Architecture)

```
src/
├── core/                    # Ядро системы
│   ├── store/              # Глобальное состояние (Zustand)
│   ├── router/             # Маршрутизация с защитой по ролям
│   ├── db/                 # IndexedDB для офлайн-хранения
│   └── types/              # Общие типы TypeScript
│
├── modules/
│   ├── auth/               # Модуль авторизации
│   │   ├── components/     # LoginForm, RegisterForm
│   │   ├── hooks/          # useAuth, useSession
│   │   ├── services/       # AuthService
│   │   └── index.ts        # Публичный API модуля
│   │
│   ├── users/              # Модуль управления пользователями
│   │   ├── components/     # UserList, UserCard, UserForm
│   │   ├── hooks/          # useUsers, useRoles
│   │   ├── services/       # UserService
│   │   └── index.ts
│   │
│   ├── tasks/              # Модуль управления заданиями
│   │   ├── components/     # TaskBoard, TaskCard, TaskForm
│   │   ├── hooks/          # useTasks, useTaskFlow
│   │   ├── services/       # TaskService
│   │   └── index.ts
│   │
│   ├── communication/      # Модуль коммуникации
│   │   ├── components/     # QRScanner, QRGenerator, LinkShare
│   │   ├── hooks/          # useBluetooth, useQR, useDeepLink
│   │   ├── services/       # BluetoothService, QRService
│   │   └── index.ts
│   │
│   ├── sync/               # Модуль синхронизации (Master-Slave)
│   │   ├── components/     # SyncStatus, MeshNetwork, DeviceList
│   │   ├── hooks/          # useSync, useMesh, useMasterSlave
│   │   ├── services/       # SyncService, MeshService
│   │   └── index.ts
│   │
│   ├── dashboard/          # Модуль дашборда (ролевой)
│   │   ├── components/     # WorkerDashboard, TechDashboard, MasterDashboard, ChiefDashboard
│   │   ├── hooks/          # useDashboard
│   │   └── index.ts
│   │
│   └── reports/            # Модуль отчётов
│       ├── components/     # ReportList, ReportChart
│       ├── hooks/          # useReports
│       └── index.ts
│
├── shared/                 # Общие компоненты
│   ├── ui/                 # UI-библиотека (Button, Card, Modal, etc.)
│   ├── layouts/            # Layouts для разных ролей
│   └── hooks/              # Общие хуки
│
├── App.tsx                 # Точка входа
└── main.tsx               # Bootstrap
```

## Роли и права доступа

| Функция | Работник | Технолог | Мастер цеха | Нач. производства |
|---------|----------|----------|-------------|-------------------|
| Просмотр своих заданий | ✅ | ✅ | ✅ | ✅ |
| Создание заданий | ❌ | ❌ | ✅ | ✅ |
| Назначение заданий | ❌ | ❌ | ✅ | ✅ |
| Управление пользователями | ❌ | ❌ | ❌ | ✅ |
| Просмотр всех заданий | ❌ | ✅ | ✅ | ✅ |
| Технологические карты | ❌ | ✅ | ✅ | ✅ |
| Отчёты цеха | ❌ | ❌ | ✅ | ✅ |
| Отчёты производства | ❌ | ❌ | ❌ | ✅ |
| Master-Slave управление | ❌ | ❌ | ✅ | ✅ |
| Настройка Bluetooth Mesh | ❌ | ❌ | ❌ | ✅ |

## Этапы разработки

### Этап 1: Ядро и авторизация (текущий)
- [x] Модульная структура
- [ ] Система ролей и прав
- [ ] Авторизация (логин/пароль)
- [ ] Хранение данных в IndexedDB
- [ ] Базовый UI

### Этап 2: Управление пользователями
- [ ] CRUD сотрудников
- [ ] Назначение ролей
- [ ] Профили пользователей

### Этап 3: Управление заданиями
- [ ] Создание заданий
- [ ] Назначение работникам
- [ ] Статусы заданий (создано → в работе → проверено → завершено)
- [ ] Технологические карты

### Этап 4: Коммуникация
- [ ] QR-код генерация/сканирование
- [ ] Deep links для передачи заданий
- [ ] Bluetooth Low Energy (BLE) передача
- [ ] Bluetooth Mesh для mesh-сети

### Этап 5: Синхронизация Master-Slave
- [ ] Обнаружение устройств
- [ ] Master-slave pairing
- [ ] Принудительная синхронизация данных
- [ ] Конфликт-резолюшн

### Этап 6: PWA и офлайн
- [ ] Service Worker
- [ ] Offline-first стратегия
- [ ] PWA манифест
- [ ] TWA (Trusted Web Activity) для Android APK

### Этап 7: Отчёты и аналитика
- [ ] Статистика по заданиям
- [ ] KPI работников
- [ ] Графики и диаграммы

## Технологии

- **Frontend**: React 18 + TypeScript + Tailwind CSS
- **State**: Zustand (лёгкий, модульный)
- **Routing**: React Router v6
- **Storage**: IndexedDB (через Dexie.js для офлайн)
- **PWA**: Vite PWA Plugin
- **Bluetooth**: Web Bluetooth API
- **QR**: html5-qrcode (сканирование) + qrcode.react (генерация)
- **Build**: Vite + Capacitor (для APK)

## Bluetooth Mesh архитектура

```
[Master Device] ←→ [Slave 1] ←→ [Slave 2]
      ↑                              ↑
      ↓                              ↓
[Slave 3] ←→ [Slave 4] ←→ [Slave 5]
```

- Master (мастер цеха/нач. производства) может отправлять данные всем slave
- Slave устройства синхронизируют данные между собой
- При отсутствии связи с master, slave работают автономно
- При восстановлении связи - автоматическая синхронизация
