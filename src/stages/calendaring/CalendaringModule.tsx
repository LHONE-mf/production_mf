import React from 'react';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

export function CalendaringModule() {
  return <StageRoom stage={StageId.CALENDARING} title="Каландрирование" icon="🔄" />;
}
