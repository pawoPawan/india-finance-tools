#!/bin/bash
# MF Analyzer — start the server and open browser
cd "$(dirname "$0")"
PORT=5001

# Kill any existing instance
lsof -ti:$PORT | xargs kill -9 2>/dev/null
sleep 0.5

echo "Starting MF Analyzer on http://127.0.0.1:$PORT"
python3 server.py --port $PORT &

# Wait for server to be ready
for i in {1..10}; do
  sleep 1
  curl -s "http://127.0.0.1:$PORT/api/meta" > /dev/null 2>&1 && break
done

open "http://127.0.0.1:$PORT/"
echo "Open: http://127.0.0.1:$PORT"
wait
