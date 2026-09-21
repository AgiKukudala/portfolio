#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -x .tools/go/bin/go ]; then PATH="$PWD/.tools/go/bin:$PATH"; export PATH; fi
gofmt -w cmd internal tests
go vet ./...
go test -count=1 ./...
if [ "${RACE:-0}" = 1 ]; then go test -race -count=1 ./...; fi
