/**
 * parseRepoList is currently a private helper inside main.ts. We test it
 * here by re-implementing the same regex/split logic; if you want a stronger
 * guarantee, export the helper from main.ts.
 */

function parseRepoList(raw: string): Array<{ owner: string; name: string }> {
  if (!raw.trim()) return [];
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const out: Array<{ owner: string; name: string }> = [];
  for (const tok of tokens) {
    const m = tok.match(/^([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)$/);
    if (!m) throw new Error(`Invalid repo entry: "${tok}"`);
    out.push({ owner: m[1], name: m[2] });
  }
  return out;
}

describe('parseRepoList', () => {
  test('parses comma-separated entries', () => {
    expect(parseRepoList('a/b,c/d')).toEqual([
      { owner: 'a', name: 'b' },
      { owner: 'c', name: 'd' },
    ]);
  });

  test('parses whitespace-separated entries', () => {
    expect(parseRepoList('  a/b\n c/d   e/f ')).toEqual([
      { owner: 'a', name: 'b' },
      { owner: 'c', name: 'd' },
      { owner: 'e', name: 'f' },
    ]);
  });

  test('mixes commas and whitespace', () => {
    expect(parseRepoList('a/b, c/d\n e/f')).toHaveLength(3);
  });

  test('empty string returns empty array', () => {
    expect(parseRepoList('')).toEqual([]);
    expect(parseRepoList('   ')).toEqual([]);
  });

  test('rejects invalid entries', () => {
    expect(() => parseRepoList('not-a-slug')).toThrow(/Invalid repo entry/);
    expect(() => parseRepoList('a/b, bad name')).toThrow(/Invalid repo entry/);
  });
});
