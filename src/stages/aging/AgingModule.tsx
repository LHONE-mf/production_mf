import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function AgingModule() {
  return <StageRoom stage={StageId.AGING} title="Старение" icon="⏳" />;
}
