FROM golang:1.27-alpine AS builder

WORKDIR /src
COPY go.mod go.sum* ./
# Bound compiler/test concurrency on shared deployment hosts.
ENV GOMAXPROCS=1
ENV GOFLAGS="-p=1"
RUN go mod download
# Keep the build context future-proof as backend services are split into
# focused files; tests still run inside the image build before compilation.
COPY *.go ./
COPY reviewbundle/ ./reviewbundle/
COPY pb_migrations/ ./pb_migrations/
COPY keyboards/ ./keyboards/
RUN go test ./...

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
# These arrive from CI inputs and operator env, and the ldflags line below
# expands them in a shell, so reject anything that is not a plain stamp.
RUN /bin/sh -c 'for stamp in "$VERSION" "$COMMIT" "$BUILD_DATE"; do \
      case "$stamp" in -*) echo "build stamp may not start with -" && exit 1;; *[!A-Za-z0-9._+:-]*) echo "unsafe build stamp: $stamp" && exit 1;; esac; \
    done'
LABEL org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.version="${VERSION}"
RUN CGO_ENABLED=0 go build -trimpath \
  -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildDate=${BUILD_DATE}" \
  -o /out/pocketbase .

FROM alpine:3.24

RUN apk add --no-cache ca-certificates curl poppler-utils libwebp-tools \
  && addgroup -g 10001 fangji \
  && adduser -D -u 10001 -G fangji fangji \
  && mkdir -p /pb/pb_data \
  && chown 10001:10001 /pb/pb_data

COPY --from=builder /out/pocketbase /pb/pocketbase
RUN chmod +x /pb/pocketbase

COPY pb_hooks/     /pb/pb_hooks/
COPY pb_migrations/ /pb/pb_migrations/
COPY docker-entrypoint.sh /pb/docker-entrypoint.sh
RUN chmod +x /pb/docker-entrypoint.sh

WORKDIR /pb

USER 10001:10001

EXPOSE 8090

CMD ["/pb/docker-entrypoint.sh"]
