import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function FormationModule() {
  return <StageRoom stage={StageId.FORMATION} title="Формирование (ЧЦЦ)" icon="⚡" />;
}
