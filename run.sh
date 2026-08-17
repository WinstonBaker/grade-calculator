#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -r requirements.txt

(cd frontend && npm install)

uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000 &
API_PID=$!
trap 'kill "$API_PID"' EXIT

cd frontend
npm run dev
