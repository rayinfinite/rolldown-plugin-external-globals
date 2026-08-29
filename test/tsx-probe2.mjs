/**
 * Diagnose WHY the original plugin fails on TSX under rolldown:
 * what code does its transform receive, and does this.parse throw on it?
 */
import { rolldown } from 'rolldown';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'eg-tsx2-'));
try {
  const entry = join(dir, 'entry.tsx');
  await writeFile(
    entry,
    'import jq from "jquery";\nconst n: number = 1;\nconst App = () => <div>{jq(".x")}</div>;\nexport default App;\n',
  );

  const spy = {
    name: 'spy',
    // run before the internal TS transform? enforce order to see raw code
    transform: {
      order: 'pre',
      handler(code, id) {
        if (!id.endsWith('.tsx')) return null;
        console.log('received code head:', JSON.stringify(code.slice(0, 60)));
        try {
          this.parse(code);
          console.log('this.parse: OK');
        } catch (e) {
          console.log('this.parse THROWS:', e.message.slice(0, 120));
        }
        return null;
      },
    },
  };

  const b = await rolldown({ input: entry, plugins: [spy] });
  await b.generate({ format: 'esm' });
  await b.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
