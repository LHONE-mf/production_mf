// Регистрация Service Worker для офлайн-режима (PWA).
// vite-plugin-pwa генерирует sw.js при сборке; здесь подключаем его к приложению.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        registerSW({ immediate: true });
      })
      .catch(() => {
        // в dev-режиме плагин может не отдавать sw.js — это нормально
      });
  });
}
