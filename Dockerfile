# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS builder

RUN apk add --no-cache ca-certificates

WORKDIR /build

# Copy workspace manifests first → maximize layer cache reuse
COPY go.work go.work.sum ./
COPY relay/go.mod relay/go.sum ./relay/
COPY gen/go/go.mod ./gen/go/

# Download dependencies (workspace-aware)
RUN go mod download

# Copy source
COPY relay/ ./relay/
COPY gen/go/ ./gen/go/

# Build static binary from workspace root
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" \
    -o /out/pinchd \
    ./relay/cmd/pinchd


FROM alpine:3.20 AS runtime

RUN apk add --no-cache ca-certificates && mkdir -p /data

COPY --from=builder /out/pinchd /usr/local/bin/pinchd

# Map Railway's injected PORT → PINCH_RELAY_PORT; exec replaces shell so
# pinchd gets PID 1 and receives SIGTERM for graceful shutdown
CMD ["sh", "-c", "PINCH_RELAY_PORT=${PORT:-8080} exec /usr/local/bin/pinchd"]
