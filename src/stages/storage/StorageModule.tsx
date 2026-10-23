import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function StorageModule() {
  return <StageRoom stage={StageId.STORAGE} title="Склад материалов" icon="📦" />;
}
