import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function AssemblyModule() {
  return <StageRoom stage={StageId.ASSEMBLY} title="Сборка элементов" icon="🔋" />;
}
