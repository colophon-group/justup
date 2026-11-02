// Keep reveal history bounded to current rows without resetting surviving admissions.
export function retainRevealedIds(admitted: ReadonlySet<string>, current: ReadonlySet<string>): ReadonlySet<string> {
  if ([...admitted].every(id => current.has(id))) return admitted;
  return new Set([...admitted].filter(id => current.has(id)));
}
