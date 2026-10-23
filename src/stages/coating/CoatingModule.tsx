import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function CoatingModule() {
  return <StageRoom stage={StageId.COATING} title="Нанесение покрытия" icon="🖌️" />;
}
