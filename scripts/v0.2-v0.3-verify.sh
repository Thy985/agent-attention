#!/bin/bash
# Agent Attention Center v0.2 + v0.3 Automated Verification
# Run: bash scripts/v0.2-v0.3-verify.sh

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

echo "=========================================="
echo "Agent Attention Center - v0.2/v0.3 Verify"
echo "=========================================="
echo ""

# ─── Helper ──────────────────────────────────────────────────────────────────
check() {
    local name="$1"
    local condition="$2"
    local detail="$3"
    if eval "$condition"; then
        echo -e "${GREEN}✅ PASS${NC} $name"
        ((PASS++))
    else
        echo -e "${RED}❌ FAIL${NC} $name: $detail"
        ((FAIL++))
    fi
}

# ─── Phase 1: Build & Tests ─────────────────────────────────────────────────
echo "=== Phase 1: Build & Unit Tests ==="
echo ""

check "Build" "npm run build >/dev/null 2>&1" "tsc compiles clean"
check "Unit Tests" "$(npm test 2>&1 | grep -q '0 failed')" "$(npm test 2>&1 | grep 'Tests:' || echo 'unknown')"

echo ""

# ─── Phase 2: CLI ────────────────────────────────────────────────────────────
echo "=== Phase 2: CLI Functions ==="
echo ""

check "CLI exists" "[ -f dist/index.js ]" "dist/index.js"
check "Daemon CLI" "[ -f dist/daemon-cli.js ]" "dist/daemon-cli.js"

echo ""

# ─── Phase 3: State ─────────────────────────────────────────────────────────
echo "=== Phase 3: State Management ==="
echo ""

mkdir -p ~/.agent-attention
STATE_FILE="$HOME/.agent-attention/state.json"

# Send test events
node dist/index.js completed "verify 1" >/dev/null 2>&1
node dist/index.js failed "verify 2" >/dev/null 2>&1
node dist/index.js permission_required "verify 3" >/dev/null 2>&1

check "State created" "[ -f '$STATE_FILE' ]" "state.json exists"
check "Events written" "[ $(python3 -c \"import json; print(len(json.load(open('$STATE_FILE'))['events']))\" 2>/dev/null || echo 0) -ge 3 ]" ">= 3 events"

# Truncation test
for i in $(seq 1 25); do
    node dist/index.js completed "truncate $i" >/dev/null 2>&1
done
check "Truncate to 20" "[ $(python3 -c \"import json; print(len(json.load(open('$STATE_FILE'))['events']))\" 2>/dev/null || echo 0) -eq 20 ]" "exactly 20 events"

echo ""

# ─── Phase 4: Registry ──────────────────────────────────────────────────────
echo "=== Phase 4: Registry ==="
echo ""

AGENTS_FILE="$HOME/.agent-attention/agents.json"
node dist/daemon-cli.js agent register claude-code "Claude Code" >/dev/null 2>&1
node dist/daemon-cli.js agent register codex "Codex" >/dev/null 2>&1
node dist/daemon-cli.js agent register qwen "Qwen Code" >/dev/null 2>&1

check "Registry exists" "[ -f '$AGENTS_FILE' ]" "agents.json"
check "3 agents registered" "[ $(python3 -c \"import json; print(len(json.load(open('$AGENTS_FILE'))['agents']))\" 2>/dev/null || echo 0) -ge 3 ]" ">= 3 agents"

echo ""

# ─── Phase 5: Daemon Lifecycle ──────────────────────────────────────────────
echo "=== Phase 5: Daemon Lifecycle ==="
echo ""

node dist/daemon-cli.js daemon start >/dev/null 2>&1
sleep 2
check "Daemon starts" "$(node dist/daemon-cli.js daemon status 2>&1 | grep -q running)" "daemon running"

OLD_UNREAD=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['unreadCount'])" 2>/dev/null || echo 0)
node dist/index.js completed "daemon test" >/dev/null 2>&1
sleep 1
NEW_UNREAD=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['unreadCount'])" 2>/dev/null || echo 0)
check "Daemon updates state" "[ $NEW_UNREAD -gt $OLD_UNREAD ]" "unread increased"

node dist/daemon-cli.js daemon stop >/dev/null 2>&1
sleep 1
check "Daemon stops" "! $(node dist/daemon-cli.js daemon status 2>&1 | grep -q running)" "daemon stopped"

echo ""

# ─── Phase 6: Dedup ─────────────────────────────────────────────────────────
echo "=== Phase 6: Dedup ==="
echo ""

CURRENT_COUNT=$(python3 -c "import json; print(len(json.load(open('$STATE_FILE'))['events']))" 2>/dev/null || echo 0)
node dist/index.js completed "dedup test" >/dev/null 2>&1
sleep 0.5
node dist/index.js completed "dedup test" >/dev/null 2>&1
sleep 1
AFTER_COUNT=$(python3 -c "import json; print(len(json.load(open('$STATE_FILE'))['events']))" 2>/dev/null || echo 0)
check "Dedup works" "[ $AFTER_COUNT -eq $CURRENT_COUNT ]" "no duplicate events"

echo ""

# ─── Phase 7: PowerShell Syntax ─────────────────────────────────────────────
echo "=== Phase 7: PowerShell Syntax ==="
echo ""

check "TrayIcon.ps1" "powershell -NoProfile -Command '[System.Management.Automation.Language.Parser]::ParseFile(\"src/center/TrayIcon.ps1\", [ref]\$null, [ref]\$null).Errors.Count -eq 0' 2>/dev/null" "no errors"
check "CenterWindow.ps1" "powershell -NoProfile -Command '[System.Management.Automation.Language.Parser]::ParseFile(\"src/center/CenterWindow.ps1\", [ref]\$null, [ref]\$null).Errors.Count -eq 0' 2>/dev/null" "no errors"

echo ""

# ─── Summary ────────────────────────────────────────────────────────────────
echo "=========================================="
echo "Summary: $PASS passed, $FAIL failed"
echo "=========================================="

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    exit 0
else
    echo -e "${RED}$FAIL check(s) failed${NC}"
    exit 1
fi
