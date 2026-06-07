#!/bin/bash
set -e

API="${NEXT_PUBLIC_API_URL:-http://localhost:8000}"
echo "Injecting API URL: $API"

# Replace placeholder in index.html
sed "s|%%API_URL%%|${API}|g" index.html > index.tmp.html
mv index.tmp.html index.html

echo "Build complete."
echo "API URL set to: $API"