#!/bin/bash
# iMach backend starter — survives between tool calls (nohup, plain spawn)
# Usage: bash /home/z/imach-back/scripts/start-back.sh
cd /home/z/imach-back
set -a
. ./.env
set +a
pkill -f "node dist/main" 2>/dev/null
sleep 0.5
nohup node dist/main.js > /tmp/imach-back.log 2>&1 &
echo "backend pid $!"
