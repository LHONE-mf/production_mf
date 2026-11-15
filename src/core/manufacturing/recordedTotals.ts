/** Missing/invalid measurements are unknown, including historical blank strings.
 * A sum is only a declared local subtotal; it never establishes QA or inventory. */
export function recordedTotal(values: unknown[], whole = false) {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) &&
    v >= 0 && v <= Number.MAX_SAFE_INTEGER && (!whole || Number.isSafeInteger(v)));
  const sum = known.reduce((a, b) => a + b, 0);
  const overflow = !Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER;
  return { value: known.length && !overflow ? sum : null, observed: known.length,
    unknown: values.length - known.length, overflow };
}
export type RecordedTotal = ReturnType<typeof recordedTotal>;
export function displayRecordedTotal(total: RecordedTotal, digits?: number): string {
  if (total.value === null) return '—';
  const value = digits === undefined ? String(total.value) : total.value.toFixed(digits);
  return value + (total.unknown ? ' + ?' : '');
}
export function recordedTotalNote(total: RecordedTotal): string {
  return total.overflow ? 'сумма вне безопасного диапазона' :
    `значений: ${total.observed}; без значения: ${total.unknown}`;
}
