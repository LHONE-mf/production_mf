import React from 'react';
import { expect, it } from 'vitest';
import { StageId } from '../core/types';
import { renderStageIfActive } from './StageRouter';

it.each(Object.values(StageId))('uses the accessible room workspace for %s', stage => {
  const room = renderStageIfActive(`stage:${stage}`);
  expect(React.isValidElement(room)).toBe(true);
  const element = room as React.ReactElement<{ className?: string }>;
  expect(element.props.className).toContain('production-room');
  expect(element.props.className).toContain('min-w-0');
});

it('does not apply room styling to unrelated application pages', () => {
  expect(renderStageIfActive('dashboard')).toBeNull();
});
