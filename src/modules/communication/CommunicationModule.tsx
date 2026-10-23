import React, { useState } from 'react';
import { Bluetooth, QrCode, Link2, Radio, Smartphone, Send, Wifi, WifiOff } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

export function CommunicationModule() {
  const [activeMethod, setActiveMethod] = useState<'bluetooth' | 'qr' | 'link'>('bluetooth');
  const [bluetoothEnabled, setBluetoothEnabled] = useState(false);
  const [scanning, setScanning] = useState(false);

  const handleBluetoothToggle = () => {
    // В реальном приложении - Web Bluetooth API
    if ('bluetooth' in navigator) {
      setBluetoothEnabled(!bluetoothEnabled);
    } else {
      alert('Web Bluetooth API не поддерживается в этом браузере. Используйте Chrome на Android или Edge на Desktop.');
    }
  };

  const taskLink = `liion://task/assign?id=task-001&priority=high&assignee=worker-001`;
  const taskQR = taskLink;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Коммуникация</h1>
        <p className="text-slate-400 text-sm mt-1">Передача заданий через Bluetooth, QR-код или ссылку</p>
      </div>

      {/* Method tabs */}
      <div className="flex gap-2 bg-slate-800/60 p-1.5 rounded-xl border border-slate-700/50">
        {[
          { id: 'bluetooth' as const, label: 'Bluetooth', icon: <Bluetooth className="w-4 h-4" /> },
          { id: 'qr' as const, label: 'QR-код', icon: <QrCode className="w-4 h-4" /> },
          { id: 'link' as const, label: 'Ссылка', icon: <Link2 className="w-4 h-4" /> },
        ].map((method) => (
          <button
            key={method.id}
            onClick={() => setActiveMethod(method.id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
              activeMethod === method.id
                ? 'bg-blue-500 text-white shadow-lg'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {method.icon}
            <span className="hidden sm:inline">{method.label}</span>
          </button>
        ))}
      </div>

      {/* Bluetooth Panel */}
      {activeMethod === 'bluetooth' && (
        <div className="space-y-4">
          <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <Bluetooth className="w-5 h-5 text-blue-400" />
                Bluetooth Low Energy
              </h3>
              <button
                onClick={handleBluetoothToggle}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  bluetoothEnabled
                    ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {bluetoothEnabled ? 'Включён' : 'Включить'}
              </button>
            </div>

            {bluetoothEnabled ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-xl">
                  <Wifi className="w-4 h-4 text-green-400" />
                  <span className="text-green-300 text-sm">Bluetooth активен. Поиск устройств...</span>
                </div>

                <div className="space-y-2">
                  <p className="text-slate-400 text-sm">Обнаруженные устройства:</p>
                  {[
                    { name: 'Master-Device-001', rssi: -45, type: 'master' },
                    { name: 'Worker-Tablet-003', rssi: -62, type: 'slave' },
                    { name: 'Worker-Phone-007', rssi: -78, type: 'slave' },
                  ].map((device, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 bg-slate-700/30 rounded-xl">
                      <Smartphone className={`w-5 h-5 ${device.type === 'master' ? 'text-orange-400' : 'text-blue-400'}`} />
                      <div className="flex-1">
                        <p className="text-white text-sm">{device.name}</p>
                        <p className="text-slate-400 text-xs">RSSI: {device.rssi} dBm • {device.type === 'master' ? 'Master' : 'Slave'}</p>
                      </div>
                      <button className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-xs rounded-lg transition">
                        Подключить
                      </button>
                    </div>
                  ))}
                </div>

                <div className="p-3 bg-slate-700/30 rounded-xl">
                  <p className="text-slate-400 text-xs mb-2">Отправить задание по Bluetooth:</p>
                  <div className="flex gap-2">
                    <select className="flex-1 px-3 py-2 bg-slate-600/50 border border-slate-500/30 rounded-lg text-white text-sm">
                      <option>Сборка блока ячеек 48V</option>
                      <option>Сварка никелевых контактов</option>
                      <option>Тестирование BMS платы</option>
                    </select>
                    <button className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1 transition">
                      <Send className="w-4 h-4" />
                      Отправить
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <Bluetooth className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <p className="text-slate-400 text-sm mb-2">Bluetooth выключен</p>
                <p className="text-slate-500 text-xs">Нажмите "Включить" для активации BLE модуля</p>
              </div>
            )}
          </div>

          {/* Mesh info */}
          <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
            <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
              <Radio className="w-5 h-5 text-purple-400" />
              Bluetooth Mesh сеть
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 bg-slate-700/30 rounded-xl text-center">
                <p className="text-2xl font-bold text-white">4</p>
                <p className="text-slate-400 text-xs">Устройств в сети</p>
              </div>
              <div className="p-3 bg-slate-700/30 rounded-xl text-center">
                <p className="text-2xl font-bold text-green-400">98%</p>
                <p className="text-slate-400 text-xs">Покрытие</p>
              </div>
              <div className="p-3 bg-slate-700/30 rounded-xl text-center">
                <p className="text-2xl font-bold text-blue-400">12</p>
                <p className="text-slate-400 text-xs">Сообщений/мин</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* QR Panel */}
      {activeMethod === 'qr' && (
        <div className="space-y-4">
          <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
            <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
              <QrCode className="w-5 h-5 text-green-400" />
              Генерация QR-кода задания
            </h3>
            <div className="flex flex-col sm:flex-row gap-6 items-center">
              <div className="bg-white p-4 rounded-2xl">
                <QRCodeSVG value={taskQR} size={180} level="M" />
              </div>
              <div className="flex-1 space-y-3">
                <div className="p-3 bg-slate-700/30 rounded-xl">
                  <p className="text-slate-400 text-xs mb-1">Deep Link:</p>
                  <code className="text-green-300 text-xs break-all">{taskLink}</code>
                </div>
                <p className="text-slate-400 text-sm">
                  Отсканируйте QR-код для получения задания. Приложение автоматически подхватит информацию о задании.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setScanning(!scanning)}
                    className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-xl text-sm font-medium transition flex items-center gap-2"
                  >
                    <QrCode className="w-4 h-4" />
                    {scanning ? 'Остановить сканирование' : 'Сканировать QR'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {scanning && (
            <div className="bg-slate-800/60 backdrop-blur border border-green-500/30 rounded-2xl p-6">
              <div className="text-center">
                <div className="w-48 h-48 mx-auto bg-slate-900 rounded-2xl border-2 border-green-500/50 flex items-center justify-center mb-4">
                  <div className="w-32 h-32 border-2 border-green-400 rounded-xl animate-pulse flex items-center justify-center">
                    <QrCode className="w-8 h-8 text-green-400" />
                  </div>
                </div>
                <p className="text-green-300 text-sm">Наведите камеру на QR-код задания</p>
                <p className="text-slate-500 text-xs mt-1">(Демо-режим: камера не активирована)</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Link Panel */}
      {activeMethod === 'link' && (
        <div className="space-y-4">
          <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
            <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
              <Link2 className="w-5 h-5 text-blue-400" />
              Поделиться заданием по ссылке
            </h3>
            <div className="space-y-4">
              <div className="p-4 bg-slate-700/30 rounded-xl">
                <p className="text-slate-400 text-xs mb-2">Ссылка для передачи:</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={taskLink}
                    className="flex-1 px-3 py-2 bg-slate-800 border border-slate-600/50 rounded-lg text-green-300 text-sm font-mono"
                  />
                  <button
                    onClick={() => navigator.clipboard?.writeText(taskLink)}
                    className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm transition"
                  >
                    Копировать
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Telegram', color: 'bg-blue-600' },
                  { label: 'WhatsApp', color: 'bg-green-600' },
                  { label: 'Email', color: 'bg-red-600' },
                  { label: 'SMS', color: 'bg-purple-600' },
                ].map((share) => (
                  <button
                    key={share.label}
                    className={`${share.color} hover:opacity-90 text-white py-2.5 rounded-xl text-sm font-medium transition`}
                  >
                    {share.label}
                  </button>
                ))}
              </div>

              <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                <p className="text-blue-300 text-sm">
                  💡 При переходе по ссылке приложение автоматически откроется и подхватит данные задания. 
                  Если приложение не установлено, будет предложено установить PWA-версию.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { CommunicationModule as default };
