#!/usr/bin/env bash
set -euo pipefail

cd $(dirname $0)

DENO_IMAGE=${1:-benjamn/deno:async-context}
echo "Running tests using $DENO_IMAGE"

# Try changing :async-context to :unmodified to observe the tests fail, most
# immediately because AsyncContext is not defined globally.
exec docker run -v $(pwd):/deno --rm $DENO_IMAGE test --allow-read --trace-ops *.ts
