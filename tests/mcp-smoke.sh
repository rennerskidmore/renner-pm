#!/usr/bin/env bash
# MCP protocol smoke tests for pm-mcp.
# Usage: PM_MCP_URL=https://<project>.supabase.co/functions/v1/pm-mcp/<MCP_SECRET> ./mcp-smoke.sh
set -u
: "${PM_MCP_URL:?PM_MCP_URL env var required}"
BASE_URL="${PM_MCP_URL%/*}"   # strip secret for the bad-secret test
PASS=0; FAIL=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   $1";
  else FAIL=$((FAIL+1)); echo "FAIL $1: expected [$2] got [$3]"; fi
}

rpc() { curl -s -X POST "$PM_MCP_URL" -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' -d "$1"; }

# 1. initialize: echoes a known protocolVersion, advertises tools
R=$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
check "initialize echoes version" "2025-06-18" "$(echo "$R" | jq -r .result.protocolVersion)"
check "initialize advertises tools" "object" "$(echo "$R" | jq -r '.result.capabilities.tools | type')"
check "serverInfo name" "renner-pm" "$(echo "$R" | jq -r .result.serverInfo.name)"

# 2. unknown protocol version falls back
R=$(rpc '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}')
check "unknown version falls back" "2025-03-26" "$(echo "$R" | jq -r .result.protocolVersion)"

# 3. notifications/initialized -> 202 empty
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PM_MCP_URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')
check "notification -> 202" "202" "$CODE"

# 4. ping
R=$(rpc '{"jsonrpc":"2.0","id":3,"method":"ping"}')
check "ping -> empty result" "{}" "$(echo "$R" | jq -c .result)"

# 5. tools/list
R=$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')
check "tools/list count" "12" "$(echo "$R" | jq '.result.tools | length')"
check "tools have schemas" "0" "$(echo "$R" | jq '[.result.tools[] | select(.inputSchema.type != "object")] | length')"

# 6. unknown method -> -32601
R=$(rpc '{"jsonrpc":"2.0","id":5,"method":"resources/list"}')
check "unknown method -32601" "-32601" "$(echo "$R" | jq -r .error.code)"

# 7. garbage body -> -32700
R=$(rpc 'this is not json')
check "parse error -32700" "-32700" "$(echo "$R" | jq -r .error.code)"

# 8. GET -> 405
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$PM_MCP_URL")
check "GET -> 405" "405" "$CODE"

# 9. bad secret -> 404
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/wrong-secret" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')
check "bad secret -> 404" "404" "$CODE"

# 10. unknown tool -> -32602
R=$(rpc '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nope","arguments":{}}}')
check "unknown tool -32602" "-32602" "$(echo "$R" | jq -r .error.code)"

# 11. tool error in-band (task not found)
R=$(rpc '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_task","arguments":{"id":999999}}}')
check "missing task isError" "true" "$(echo "$R" | jq -r .result.isError)"

echo
echo "passed $PASS, failed $FAIL"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
