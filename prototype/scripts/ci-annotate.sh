# CI 用：ann <指令…> 執行指令；失敗時把輸出最後 1,500 字寫成 GitHub 註解（可經 API 讀取），並傳回原退出碼
ann() {
  local log rc
  log="$(mktemp)"
  # 在 set -e 下也要能取得退出碼並寫出註解
  if "$@" > >(tee "$log") 2>&1; then rc=0; else rc=$?; fi
  wait
  if [ "$rc" -ne 0 ]; then
    echo "::error title=$(basename "$1") exit $rc::$(tail -c 1500 "$log" | tr '\r\n' '  ' | sed 's/::/: :/g')"
  fi
  return "$rc"
}
