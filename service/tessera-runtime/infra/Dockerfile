FROM golang:1.26.10-bookworm AS build

WORKDIR /workspace/service/tessera-runtime

COPY service/tessera-runtime/go.mod ./
COPY service/tessera-runtime/main.go ./
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/tessera-runtime .

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=build /out/tessera-runtime /app/tessera-runtime

CMD ["/app/tessera-runtime"]
