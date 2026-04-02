#!/bin/bash
# remote DB에서 미분류 web_sources_raw를 JSON으로 추출
# Usage: bash scripts/oneshot/dump-unfiltered.sh

OUT="/tmp/unfiltered_all.json"
BATCH=1000
LAST_ID=0
TOTAL=0

echo "[] " > "$OUT"

while true; do
  echo "Fetching after id=$LAST_ID ..."
  RESULT=$(npx wrangler d1 execute parking-db --remote --json \
    --command "SELECT id, title, content, source_url FROM web_sources_raw WHERE ai_filtered_at IS NULL AND id > $LAST_ID ORDER BY id ASC LIMIT $BATCH" 2>/dev/null)

  COUNT=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d[0].get('results',[])))" 2>/dev/null)

  if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
    echo "Done. Total: $TOTAL rows"
    break
  fi

  # append rows to output
  echo "$RESULT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
rows = data[0].get('results', [])
# append to existing file
existing = json.load(open('$OUT'))
existing.extend(rows)
json.dump(existing, open('$OUT', 'w'), ensure_ascii=False)
print(f'  got {len(rows)} rows, last id: {rows[-1][\"id\"]}')
" 2>/dev/null

  LAST_ID=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['results'][-1]['id'])" 2>/dev/null)
  TOTAL=$((TOTAL + COUNT))

  sleep 1
done

echo "Output: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, $TOTAL rows)"
