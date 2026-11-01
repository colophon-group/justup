// Strict product runtime parsing. Deployment launchers provide JUSTUP_* names;
// invalid values stop startup without exposing their contents.
export function runtimeEnv(env = process.env, suffix) {
  return env[`JUSTUP_${suffix}`];
}
export function booleanEnv(env, suffix, fallback = false) {
  const value = runtimeEnv(env, suffix);
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value)) throw new TypeError(`Invalid runtime configuration: ${suffix}.`);
  return value === 'true';
}
export function integerEnv(env, suffix, { nullable = false } = {}) {
  const value = runtimeEnv(env, suffix);
  if (value === undefined) return undefined;
  if (nullable && value === 'none') return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TypeError(`Invalid runtime configuration: ${suffix}.`);
  return Number(value);
}
