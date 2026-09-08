import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/runClone.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['playwright-core', 'mime-types', 'handlebars', 'commander', 'robots-parser'],
  noExternal: [
    'p-queue',
    'parse5',
  ],
});
