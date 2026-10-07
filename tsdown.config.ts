import { clientBundle } from './scripts/dsh-client-preset.ts'

const PLUGIN_ID = '@sh1robana/dsh-plugin-message-edit'
const clientConfig = clientBundle(PLUGIN_ID)

export default () => [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['@deepseek-ai/dsh-session'] },
  },
  clientConfig,
]
