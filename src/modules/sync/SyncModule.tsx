import React, { useState } from 'react';
import { Radio, RefreshCw, Smartphone, Wifi, WifiOff, ArrowUpCircle, ArrowDownCircle, AlertCircle, CheckCircle2 } from 'lucide-react';

interface Device {
  id: string;
  name: string;
  type: 'master' | 'slave';
  status: 'connected' | 'syncing' | 'offline' | 'error';
  lastSync?: string;
  pendingChanges: number;
}

const DEMO_DEVICES: Device[] = [
  { id: '1', name: 'Master-Device (Мастер)', type: 'master', status: 'connected', lastSync: '2 мин назад', pendingChanges: 0 },
  { id: '2', name: 'Slave-Tablet-01 (Козлов)', type: 'slave', status: 'connected', lastSync: '5 мин назад', pendingChanges: 3 },
  { id: '3', name: 'Slave-Phone-02 (Новиков)', type: 'slave', status: 'syncing', lastSync: 'Синхронизация...', pendingChanges: 1 },
  { id: '4', name: 'Slave-Tablet-03 (Морозов)', type: 'slave', status: 'offline', lastSync: '2 часа назад', pendingChanges: 12 },
];

export function SyncModule() {
  const [devices, setDevices] = useState<Device[]>(DEMO_DEVICES);
  const [isSyncing, setIsSyncing] = useState(false);

  const handleForceSync = (deviceId: string) => {
    setDevices(devices.map(d => 
      d.id === deviceId ? { ...d, status: 'syncing' as const, lastSync: 'Синхронизация...' } : d
    ));
    setTimeout(() => {
      setDevices(devices.map(d => 
        d.id === deviceId ? { ...d, status: 'connected' as const, lastSync: 'Только что', pendingChanges: 0 } : d
      ));
    }, 2000);
  };

  const handleSyncAll = () => {
    setIsSyncing(true);
    setTimeout(() => setIsSyncing(false), 3000);
  };

  const statusConfig = {
    connected: { icon: Wifi, color: 'text-green-400', bg: 'bg-green-500/20', label: 'Подключено' },
    syncing: { icon: RefreshCw, color: 'text-blue-400', bg: 'bg-blue-500/20', label: 'Синхронизация' },
    offline: { icon: WifiOff, color: 'text-slate-400', bg: 'bg-slate-500/20', label: 'Офлайн' },
    error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/20', label: 'Ошибка' },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Синхронизация</h1>
          <p className="text-slate-400 text-sm mt-1">Master-Slave модель • Bluetooth Mesh</p>
        </div>
        <button
          onClick={handleSyncAll}
          disabled={isSyncing}
          className="flex items-center gap-2 px-4 py-2.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded-xl font-medium transition shadow-lg shadow-green-500/20"
        >
          <RefreshCw className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
          {isSyncing ? 'Синхронизация...' : 'Синхронизировать все'}
        </button>
      </div>

      {/* Network overview */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-white">{devices.length}</p>
          <p className="text-slate-400 text-xs">Всего устройств</p>
        </div>
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-green-400">{devices.filter(d => d.status === 'connected').length}</p>
          <p className="text-slate-400 text-xs">Онлайн</p>
        </div>
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-orange-400">{devices.reduce((acc, d) => acc + d.pendingChanges, 0)}</p>
          <p className="text-slate-400 text-xs">Ожидают синхр.</p>
        </div>
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-blue-400">1</p>
          <p className="text-slate-400 text-xs">Master</p>
        </div>
      </div>

      {/* Mesh topology */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
        <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
          <Radio className="w-5 h-5 text-purple-400" />
          Топология Mesh-сети
        </h3>
        <div className="flex flex-col items-center">
          {/* Master node */}
          <div className="w-40 p-3 bg-orange-500/20 border border-orange-500/30 rounded-2xl text-center mb-4">
            <Smartphone className="w-6 h-6 text-orange-400 mx-auto mb-1" />
            <p className="text-white text-xs font-medium">Master</p>
            <p className="text-orange-300 text-xs">Мастер цеха</p>
          </div>
          
          {/* Connections */}
          <div className="flex items-center gap-2 mb-4">
            <div className="w-px h-8 bg-slate-600" />
          </div>
          <div className="flex gap-4 flex-wrap justify-center">
            <div className="w-px h-4 bg-slate-600" />
          </div>
          
          {/* Slave nodes */}
          <div className="grid grid-cols-3 gap-3 w-full max-w-md">
            {devices.filter(d => d.type === 'slave').map((device) => {
              const config = statusConfig[device.status];
              const Icon = config.icon;
              return (
                <div key={device.id} className={`p-3 ${config.bg} border border-current/20 rounded-xl text-center`}>
                  <Icon className={`w-5 h-5 ${config.color} mx-auto mb-1 ${device.status === 'syncing' ? 'animate-spin' : ''}`} />
                  <p className="text-white text-xs font-medium truncate">{device.name.split('(')[0].trim()}</p>
                  <p className={`${config.color} text-xs`}>{config.label}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Device list */}
      <div className="space-y-3">
        <h3 className="text-white font-semibold">Устройства</h3>
        {devices.map((device) => {
          const config = statusConfig[device.status];
          const StatusIcon = config.icon;
          return (
            <div key={device.id} className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 ${device.type === 'master' ? 'bg-orange-500/20' : 'bg-blue-500/20'} rounded-xl flex items-center justify-center`}>
                  <Smartphone className={`w-5 h-5 ${device.type === 'master' ? 'text-orange-400' : 'text-blue-400'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-white text-sm font-medium truncate">{device.name}</p>
                    <span className={`px-2 py-0.5 rounded text-xs ${device.type === 'master' ? 'bg-orange-500/20 text-orange-300' : 'bg-blue-500/20 text-blue-300'}`}>
                      {device.type === 'master' ? 'Master' : 'Slave'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className={`flex items-center gap-1 text-xs ${config.color}`}>
                      <StatusIcon className={`w-3 h-3 ${device.status === 'syncing' ? 'animate-spin' : ''}`} />
                      {device.lastSync}
                    </span>
                    {device.pendingChanges > 0 && (
                      <span className="text-orange-300 text-xs flex items-center gap-1">
                        <ArrowUpCircle className="w-3 h-3" />
                        {device.pendingChanges} изменений
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  {device.status !== 'connected' && device.status !== 'syncing' && (
                    <button
                      onClick={() => handleForceSync(device.id)}
                      className="px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 text-xs rounded-lg transition flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Sync
                    </button>
                  )}
                  {device.type === 'slave' && (
                    <button className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs rounded-lg transition">
                      Принуд. данные
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Sync log */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6">
        <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
          <CheckCircle2 className="w-5 h-5 text-green-400" />
          Журнал синхронизации
        </h3>
        <div className="space-y-2">
          {[
            { time: '10:45:12', device: 'Slave-Tablet-01', direction: '↓', records: 3, status: 'success' },
            { time: '10:43:08', device: 'Slave-Phone-02', direction: '↕', records: 5, status: 'success' },
            { time: '10:40:33', device: 'Slave-Tablet-03', direction: '↑', records: 0, status: 'error' },
            { time: '10:38:15', device: 'Slave-Tablet-01', direction: '↓', records: 2, status: 'success' },
            { time: '10:35:44', device: 'Slave-Phone-02', direction: '↕', records: 8, status: 'success' },
          ].map((log, i) => (
            <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-700/30">
              <span className="text-slate-500 text-xs w-16">{log.time}</span>
              <span className="text-white text-xs flex-1">{log.device}</span>
              <span className="text-blue-300 text-xs">{log.direction}</span>
              <span className="text-slate-400 text-xs">{log.records} записей</span>
              {log.status === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-400" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { SyncModule as default };
