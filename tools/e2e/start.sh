#!/usr/bin/env bash
# 在隔离的 home 里启动一个悬浮标测试实例（不碰你真实的 ~/.claude、~/.clawd、%APPDATA%）。
#
#   bash tools/e2e/start.sh                # 开发版（先 pnpm --filter @xfb/desktop build）
#   E2E_EXE=release/win-unpacked/XuanFuBiao.exe bash tools/e2e/start.sh   # 打包版
#   E2E_SETTINGS='{"petSkin":"xfb-blob"}' bash tools/e2e/start.sh       # 预置设置
#
# 额外环境变量会原样传给悬浮标，常用的自检开关：
#   XFB_CLAWD_IGNORE_RUNNING=1  真 clawd 开着也照样监听（隔离 home 下端口会落到 23334）
#   XFB_REPOINT_SELFTEST=1      启动后直接「让 hooks 改由悬浮标提供」，不弹确认
#   XFB_OPEN_AGENTS=1           启动时打开编码代理设置窗口
#   XFB_CLAWD_DEBUG=1           打 clawd 自己的详细日志、记录上游读了哪些没提供的 ctx 字段
#
# 页面用 tools/e2e/cdp.cjs 读写；结束用 kill.ps1。端口写在 $E2E_HOME/.clawd/runtime.json。
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
H="${E2E_HOME:-$(node -p "require('os').tmpdir().split(require('path').sep).join('/')")/xfb-e2e-home}"
rm -rf "$H"; mkdir -p "$H/AppData/Roaming/XuanFuBiao" "$H/AppData/Local"
echo "${E2E_SETTINGS:-{\"onboarded\":true\}}" > "$H/AppData/Roaming/XuanFuBiao/settings.json"
cd "$ROOT/apps/desktop"
EXE="${E2E_EXE:-./node_modules/.bin/electron}"
ARGS="."; [ -n "$E2E_EXE" ] && ARGS=""
USERPROFILE="$H" HOME="$H" APPDATA="$H/AppData/Roaming" LOCALAPPDATA="$H/AppData/Local" XFB_CLAWD_IGNORE_RUNNING="${XFB_CLAWD_IGNORE_RUNNING:-1}" \
  "$EXE" $ARGS --remote-debugging-port=9333 > "$H/e2e.log" 2>&1 &
for i in $(seq 1 40); do [ -f "$H/.clawd/runtime.json" ] && break; sleep 0.5; done
echo "home=$H"
echo "log=$H/e2e.log"
[ -f "$H/.clawd/runtime.json" ] && node -p "'port=' + JSON.parse(require('fs').readFileSync('$H/.clawd/runtime.json','utf8')).port"
