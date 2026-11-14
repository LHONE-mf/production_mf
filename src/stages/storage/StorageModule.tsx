import React from 'react';
import {ConfirmedStorage} from './ConfirmedStorage';
import {InventoryIssues} from './InventoryIssues';
import {StorageRegister} from './StorageRegister';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function StorageModule() {
  return <StageRoom stage={StageId.STORAGE} title="Склад материалов" icon="📦" description="Подтверждённые остатки, поступления и контролируемая выдача в производство. Локальные наблюдения показаны отдельно." tool={<><ConfirmedStorage/><InventoryIssues/><h3 className="mt-4 font-semibold">Локальный журнал — наблюдения без подтверждённого остатка</h3><StorageRegister/></>} preserveToolDraft />;
}
