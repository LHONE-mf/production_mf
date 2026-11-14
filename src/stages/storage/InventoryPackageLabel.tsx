import React from 'react';
import {QRCodeSVG} from 'qrcode.react';
import {inventoryLabel} from '../../core/sync/inventoryIdentification';
export function InventoryPackageLabel({organizationId,stockId}:{organizationId:string;stockId:string}){const value=inventoryLabel(organizationId,'container',stockId);return <details><summary className="min-h-11 cursor-pointer py-2">QR / ручной код контейнера</summary><p>Метка только идентифицирует упаковку; движение требует отдельного разрешения.</p><div className="inline-block bg-white p-3 text-black"><QRCodeSVG value={value} size={180} title={'Контейнер '+stockId}/></div><p className="break-all" data-inventory-label={value}>{value}</p></details>;}
