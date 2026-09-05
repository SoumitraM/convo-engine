import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index':                      'src/index.ts',
    'adapters/provider/claude':   'src/adapters/provider/claude.ts',
    'adapters/provider/openai':   'src/adapters/provider/openai.ts',
    'adapters/provider/gateway':  'src/adapters/provider/gateway.ts',
    'adapters/storage/in-memory': 'src/adapters/storage/in-memory.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@anthropic-ai/sdk', 'openai'],
});
