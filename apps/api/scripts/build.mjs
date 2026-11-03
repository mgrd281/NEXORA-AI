/**
 * Production build: bundles each entry point into dist/<name>.js (ESM, Node 22,
 * with source maps). Workspace packages (@jarvis/*, shipped as TypeScript
 * source) are bundled; every other package stays an external import resolved
 * from node_modules at runtime. SQL migrations are copied to dist/migrations
 * and dist/migrate.js defaults MIGRATIONS_DIR to them.
 *
 *   node scripts/build.mjs
 */
import { build } from 'esbuild';
import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const migrationsSrc = resolve(root, '../../db/migrations');

const ENTRIES = {
  server: 'src/server.ts',
  worker: 'src/worker.ts',
  cli: 'src/cli.ts',
  migrate: 'src/db/migrate.ts',
};

/** Bundle @jarvis/* workspace packages; leave every other bare import external. */
const externalPackages = {
  name: 'external-packages',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point' || args.path.startsWith('@jarvis/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

// Bundled CommonJS-style code may call require(); give ESM output a real one.
const requireBanner = [
  "import { createRequire as __jarvisCreateRequire } from 'node:module';",
  'const require = __jarvisCreateRequire(import.meta.url);',
].join('\n');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  outdir: dist,
  tsconfig: resolve(root, 'tsconfig.json'),
  plugins: [externalPackages],
  logLevel: 'warning',
  metafile: true,
};

const present = Object.entries(ENTRIES).filter(([, file]) => existsSync(resolve(root, file)));
const missing = Object.entries(ENTRIES).filter(([, file]) => !existsSync(resolve(root, file)));

rmSync(dist, { recursive: true, force: true });

const runtime = present.filter(([name]) => name !== 'migrate');
const results = [];
if (runtime.length) {
  results.push(
    await build({
      ...common,
      entryPoints: Object.fromEntries(runtime.map(([name, file]) => [name, resolve(root, file)])),
      banner: { js: requireBanner },
    }),
  );
}
if (present.some(([name]) => name === 'migrate')) {
  cpSync(migrationsSrc, resolve(dist, 'migrations'), { recursive: true });
  results.push(
    await build({
      ...common,
      entryPoints: { migrate: resolve(root, ENTRIES.migrate) },
      banner: {
        js: [
          requireBanner,
          "import { fileURLToPath as __jarvisFileURLToPath } from 'node:url';",
          "process.env.MIGRATIONS_DIR ??= __jarvisFileURLToPath(new URL('./migrations/', import.meta.url));",
        ].join('\n'),
      },
    }),
  );
}

for (const r of results) {
  for (const [file, out] of Object.entries(r.metafile.outputs)) {
    if (!file.endsWith('.js')) continue;
    const kb = (statSync(resolve(root, file)).size / 1024).toFixed(1);
    console.log(
      `built ${relative(root, resolve(root, file))} (${kb} KiB, ${Object.keys(out.inputs).length} modules)`,
    );
  }
}
for (const [name, file] of missing) {
  console.warn(`warning: ${file} does not exist; dist/${name}.js was not built`);
}
if (present.length === 0) process.exit(1);
