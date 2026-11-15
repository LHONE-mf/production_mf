import { expect, it } from 'vitest';
import { recordedTotal, displayRecordedTotal, recordedTotalNote } from './recordedTotals';

it('keeps zero, partial totals and unknown historical values distinct without numeric coercion', () => {
  expect(displayRecordedTotal(recordedTotal([]))).toBe('—');
  expect(displayRecordedTotal(recordedTotal([undefined, null, '', '3', NaN, Infinity, -1]))).toBe('—');
  const partial = recordedTotal([0, 3, undefined], true);
  expect(displayRecordedTotal(partial)).toBe('3 + ?');
  expect(recordedTotalNote(partial)).toBe('значений: 2; без значения: 1');
  expect(displayRecordedTotal(recordedTotal([0], true))).toBe('0');
  expect(displayRecordedTotal(recordedTotal([1.5], true))).toBe('—');
  expect(displayRecordedTotal(recordedTotal([1.5, 0.5]), 1)).toBe('2.0');
  expect(displayRecordedTotal(recordedTotal([Number.MAX_SAFE_INTEGER, 1], true))).toBe('—');
  expect(recordedTotalNote(recordedTotal([Number.MAX_SAFE_INTEGER, 1], true))).toContain('безопасного диапазона');
});
