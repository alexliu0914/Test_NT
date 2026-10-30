#!/usr/bin/env bash
# 打包瀏覽器測試頁（固定 esbuild 版本；有本機 esbuild 時以 ESBUILD 指定路徑）
set -euo pipefail
cd "$(dirname "$0")/.."
ESBUILD="${ESBUILD:-npx --yes esbuild@0.28.2}"
$ESBUILD web/app.js --bundle --format=esm --platform=browser --target=es2022 \
  --outdir=web/dist --loader:.woff2=file --loader:.woff=file --loader:.ttf=file \
  --define:process.env.NODE_ENV='"production"' --log-level=warning
echo "built web/dist"
