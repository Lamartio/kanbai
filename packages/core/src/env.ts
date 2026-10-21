/** Resolving `publish.env`: plain values pass through, `${NAME}` comes from the client. */

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Parses KEY=value lines: comments, blank lines, `export KEY=…` and quoted values are fine. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]!] = value;
  }
  return values;
}

/**
 * Fills in `${NAME}` references from `source` (the client's environment plus its env file).
 * Returns the resolved variables, or the names that are missing.
 */
export function resolvePublishEnv(
  env: Record<string, string>,
  source: Record<string, string | undefined>,
): { ok: true; env: Record<string, string> } | { ok: false; missing: string[] } {
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    resolved[name] = value.replace(REFERENCE, (_, ref: string) => {
      const found = source[ref];
      if (found === undefined || found === '') missing.add(ref);
      return found ?? '';
    });
  }
  return missing.size ? { ok: false, missing: [...missing] } : { ok: true, env: resolved };
}
