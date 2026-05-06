/** Normalize a Pokemon/move/ability name to a lowercase alphanumeric ID */
export function toID(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
