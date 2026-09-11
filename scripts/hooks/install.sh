#!/bin/sh
#
# 安装 git 钩子（克隆仓库后执行一次）
# 用法：sh scripts/hooks/install.sh
#
# 原理：.git/hooks/ 不随仓库分发，故钩子真身放在版本化的 scripts/hooks/，
# 安装脚本只在 .git/hooks/ 生成一个转发器（保证单一事实源，改钩子只改一处）。

set -e
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$ROOT/.git/hooks"
cat > "$ROOT/.git/hooks/pre-commit" <<'HOOK'
#!/bin/sh
exec "$(git rev-parse --show-toplevel)/scripts/hooks/pre-commit"
HOOK
chmod +x "$ROOT/.git/hooks/pre-commit" 2>/dev/null || true
chmod +x "$ROOT/scripts/hooks/pre-commit" 2>/dev/null || true
echo "已安装 pre-commit 钩子（转发至 scripts/hooks/pre-commit）"
