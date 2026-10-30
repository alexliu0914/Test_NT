#!/usr/bin/env bash
# 打包 M0-15 手機測試頁成單一 HTML（JS、CSS、測試音檔全部內嵌），供發布為 Artifact。
# 用法：bash scripts/build-mobile.sh core|mantine   → web/dist/m0-15-<variant>.html
set -euo pipefail
cd "$(dirname "$0")/.."
VARIANT="${1:-core}"
ESBUILD="${ESBUILD:-npx --yes esbuild@0.28.2}"
OUT=web/dist/mobile-$VARIANT
mkdir -p "$OUT"
$ESBUILD "web/mobile-$VARIANT.js" --bundle --format=esm --platform=browser --target=es2022 \
  --outdir="$OUT" --loader:.woff2=dataurl --loader:.woff=dataurl --loader:.ttf=dataurl \
  --conditions=style,module --define:process.env.NODE_ENV='"production"' --minify --log-level=warning
python3 - "$VARIANT" <<'PY'
import base64, sys, os
v = sys.argv[1]
d = f'web/dist/mobile-{v}'
js = open(f'{d}/mobile-{v}.js', encoding='utf8').read().replace('</script', '<\\/script')
css_path = f'{d}/mobile-{v}.css'
css = open(css_path, encoding='utf8').read() if os.path.exists(css_path) else ''
audio = base64.b64encode(open('test/fixtures/m015-tone.mp3', 'rb').read()).decode()
html = open('web/mobile.html', encoding='utf8').read()
html = html.replace('%%CSS%%', css.replace('</style', '<\\/style')).replace('%%AUDIO%%', audio).replace('%%JS%%', js)
out = f'web/dist/m0-15-{v}.html'
open(out, 'w', encoding='utf8').write(html)
print(out, len(html.encode()) // 1024, 'KB')
PY
