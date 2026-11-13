/** Call after decimal/unit parsing. Preserve strings; never round a count. */
export function hasWholeCount(value:string,unit:string):boolean {
  return !['cells','pieces'].includes(unit) || /^\d+(?:\.0+)?$/.test(value);
}
