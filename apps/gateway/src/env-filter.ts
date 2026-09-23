/**
 * Building the environment a spawned child actually sees.
 *
 * The container Render manages has every secret for all three apps in its one
 * `process.env`, because Render only gives a single service one set of
 * variables — that is the reason `hosts.ts`'s docstring gives for why
 * `envKeys` exists at all. This is where that gets narrowed back down: a
 * child's `process.env` contains *only* the keys its own `AppTarget.envKeys`
 * names, plus the handful of operational variables any Node process needs
 * just to run (`PATH` to find the `node` binary `tsx` needs, `HOME` for
 * anything that reads it). Nothing else. A bug in SignalDesk's own code that
 * tried `process.env.AGENT_SECRET_KEY` would find `undefined` — that value
 * was never copied into this child's environment in the first place.
 */

/**
 * Present regardless of which app is being spawned — none of these carry a
 * secret, and every one of them is something a plain Node process needs to
 * run and log at all.
 */
export const SYSTEM_KEYS: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL", "PWD"];

/**
 * @param source Usually `process.env` — the gateway's own, which Render populates
 * with every app's variables because Render gives one service one set.
 * @param appKeys This app's own `AppTarget.envKeys` — the only app-specific names allowed through.
 * @param overrides Applied last, so a caller can force a value (the internal `PORT` `spawnApp` assigns)
 * even if `source` happens to define the same name for something else.
 * @param aliases This app's own `AppTarget.envAliases`, `{ childName: sourceName }`: the value
 * stored under `sourceName` reaches the child as `childName`, and `sourceName` itself does not.
 * Applied after `appKeys` and before `overrides`.
 */
export function filterEnv(
  source: NodeJS.ProcessEnv,
  appKeys: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
  aliases: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...SYSTEM_KEYS, ...appKeys]) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  for (const [childName, sourceName] of Object.entries(aliases)) {
    const value = source[sourceName];
    if (value !== undefined) result[childName] = value;
  }
  return { ...result, ...overrides };
}
