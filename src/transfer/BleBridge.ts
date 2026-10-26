// Нативный BLE-мост (Capacitor плагин BleBridge, Java).
// Используется bluetooth.ts: в Android-приложении основной путь — этот модуль
// (advertising + GATT server на передатчике, scan+read на приёмнике), а
// библиотека @capacitor-community/bluetooth-le остаётся запасным путём.
//
// UUID согласованы с BleBridgePlugin.java и bluetooth.ts:
//   сервис FF60…, характеристика данных FF61…

import { registerPlugin } from '@capacitor/core';

export interface BleBridgePluginApi {
  startAdvertise(options: { packet: string }): Promise<{ ok: boolean; len: number; crc: number }>;
  stopAdvertise(): Promise<{ ok: boolean }>;
  startReceive(): Promise<{ ok: boolean }>;
  stopReceive(): Promise<{ ok: boolean }>;
  getStatus(): Promise<{ btOn: boolean; advertising: boolean; scanning: boolean }>;
  addListener(eventName: 'packet', listenerFunc: (ev: { packet: string; len: number; rssi: number }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'txClientConnected' | 'txClientDisconnected', listenerFunc: (ev: { value: string }) => void): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
}

const BleBridge = registerPlugin<BleBridgePluginApi>('BleBridge');

export default BleBridge;
