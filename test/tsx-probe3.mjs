/**
 * What code does a NORMAL-order plugin transform receive under rolldown for a
 * .tsx module: raw TSX, or already-stripped JS?
 */
import { rolldown } from 'rolldown';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'eg-tsx3-'));
try {
  const entry = join(dir, 'entry.tsx');
  await writeFile(
    entry,
    'import jq from "jquery";\nconst n: number = 1;\nconst App = () => <div>{jq(".x")}</div>;\nexport default App;\n',
  );

  const spy = {
    name: 'spy',
    transform(code, id) {
      if (!id.endsWith('.tsx')) return null;
      const hasTS = /:\s*number/.test(code);
      const hasJSX = /<div>/.test(code);
      console.log(`normal-order transform sees: TS=${hasTS} JSX=${hasJSX}`);
      console.log('  head:', JSON.stringify(code.slice(0, 70)));
      try {
        this.parse(code);
        console.log('  this.parse: OK');
      } catch (e) {
        console.log('  this.parse THROWS:', e.message.slice(0, 80));
      }
      return null;
    },
  };

  const b = await rolldown({ input: entry, plugins: [spy] });
  await b.generate({ format: 'esm' });
  await b.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
