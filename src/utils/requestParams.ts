type ParamValue = string | string[] | undefined;

/** Normalize a single Express route param to a string. */
export function param(value: ParamValue): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/** Normalize all route params — use instead of destructuring `req.params` directly. */
export function params<T extends Record<string, ParamValue>>(raw: T): { [K in keyof T]: string } {
  const result = {} as { [K in keyof T]: string };
  for (const key of Object.keys(raw) as (keyof T)[]) {
    result[key] = param(raw[key]);
  }
  return result;
}
