import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { SlurryCalculator } from './SlurryCalculator';
import { StageId } from '../../core/types';

export function SlurryModule() {
  return (
    <StageRoom stage={StageId.SLURRY} title="Приготовление шлама" icon="🧪" tool={<SlurryCalculator />} />
  );
}
