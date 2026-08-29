/**
 * Probe: does the ORIGINAL plugin transform TSX under rolldown?
 * (Its transform relies on this.parse; if TSX parsing fails the plugin
 * silently skips the module and the comparison would be invalid.)
 */
import { rolldown } from 'rolldown';
import originalPlugin from 'rollup-plugin-external-globals';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { externalGlobals } from '../plugin.mjs';

const dir = await mkdtemp(join(tmpdir(), 'eg-tsx-'));
try {
  const entry = join(dir, 'entry.tsx');
  await writeFile(
    entry,
    'import jq from "jquery";\nconst App = () => <div>{jq(".x")}</div>;\nexport default App;\n',
  );

  async function run(plugins, label) {
    const b = await rolldown({ input: entry, plugins });
    const { output } = await b.generate({ format: 'esm' });
    await b.close();
    const code = output[0].code;
    const transformed = !/["']jquery["']/.test(code) && code.includes('$(".x")');
    console.log(`${label}: transformed=${transformed}`);
    if (!transformed) console.log(code);
  }

  await run([originalPlugin({ jquery: '$' })], 'original JS plugin');
  await run([externalGlobals({ jquery: '$' })], 'native Rust plugin');
} finally {
  await rm(dir, { recursive: true, force: true });
}
