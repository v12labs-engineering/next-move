import { build } from 'esbuild'
await build({entryPoints:['workers/browser-use/captcha-worker.ts'],outfile:'workers/browser-use/captcha-worker.mjs',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',minify:false})
