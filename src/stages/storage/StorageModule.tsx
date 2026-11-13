import React from 'react';
import {StorageRegister} from './StorageRegister';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function StorageModule() {
  return <StageRoom stage={StageId.STORAGE} title="Склад материалов" icon="📦" description="Поступления партий и история записанных мест хранения. Выберите поступление, чтобы открыть его источник и историю; это не подтверждённый складской остаток." tool={<StorageRegister/>} preserveToolDraft />;
}
