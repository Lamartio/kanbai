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
): { ok: true; env: Record<string, string>; secrets: string[] } | { ok: false; missing: string[] } {
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    let referenced = false;
    resolved[name] = value.replace(REFERENCE, (_, ref: string) => {
      referenced = true;
      const found = source[ref];
      if (found === undefined || found === '') missing.add(ref);
      else secrets.add(found);
      return found ?? '';
    });
    // A value built from a reference ("Bearer ${TOKEN}") is secret as a whole too.
    if (referenced && resolved[name]) secrets.add(resolved[name]!);
  }
  return missing.size ? { ok: false, missing: [...missing] } : { ok: true, env: resolved, secrets: [...secrets] };
}

/** Values shorter than this aren't masked: they would garble ordinary output. */
const MIN_SECRET_LENGTH = 4;

/** Replaces every secret value in `text` with ***. Longer secrets first, so overlaps mask fully. */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  const list = [...new Set(secrets)].filter((secret) => secret.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  let masked = text;
  for (const secret of list) masked = masked.split(secret).join('***');
  return masked;
}
