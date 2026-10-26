import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function ElectrolyteModule() {
  return <StageRoom stage={StageId.ELECTROLYTE} title="Розлив электролита" icon="💧" />;
}
