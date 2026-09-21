GO := $(shell if [ -x .tools/go/bin/go ]; then echo .tools/go/bin/go; else echo go; fi)
PROTOC := $(shell if [ -x .tools/protoc/bin/protoc ]; then echo .tools/protoc/bin/protoc; else echo protoc; fi)
.PHONY: build test race vet check proto cluster bench
build:
	mkdir -p bin
	$(GO) build -o bin/asterkv-node ./cmd/node
	$(GO) build -o bin/asterkv-client ./cmd/client
	$(GO) build -o bin/asterkv-bench ./cmd/bench
test:
	$(GO) test ./...
race:
	$(GO) test -race ./...
vet:
	$(GO) vet ./...
check:
	RACE=1 ./scripts/check.sh
proto:
	PATH="$$PWD/.tools/bin:$$PATH" $(PROTOC) --go_out=. --go_opt=module=asterkv --go-grpc_out=. --go-grpc_opt=module=asterkv proto/asterkv/v1/asterkv.proto
cluster: build
	./scripts/cluster.sh
bench: build
	./bin/asterkv-bench -scenario=all -n=100
