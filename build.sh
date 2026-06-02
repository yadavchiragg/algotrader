#!/usr/bin/env bash
# Render build script — runs in the repo root
# Builds Next.js static export, then pip-installs backend
set -e

echo "=== Installing Node deps ==="
cd frontend
npm ci

echo "=== Building Next.js static export ==="
npm run build
# Output is at frontend/out/

echo "=== Installing Python deps ==="
cd ../backend
pip install -r requirements.txt

echo "=== Build complete ==="