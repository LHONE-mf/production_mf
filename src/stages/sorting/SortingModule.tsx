import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function SortingModule() {
  return <StageRoom stage={StageId.SORTING} title="Сортировка" icon="✂️" />;
}
