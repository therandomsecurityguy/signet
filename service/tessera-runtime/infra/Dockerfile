FROM golang:1.26.10-bookworm@sha256:5de7c99eb78ca5e515a4c340235d0955ec5964a5071c492c15503d7c267da473 AS build

WORKDIR /workspace/service/tessera-runtime

COPY service/tessera-runtime/go.mod ./
COPY service/tessera-runtime/main.go ./
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/tessera-runtime .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

WORKDIR /app

COPY --from=build /out/tessera-runtime /app/tessera-runtime

CMD ["/app/tessera-runtime"]
