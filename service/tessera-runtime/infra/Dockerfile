FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS build

WORKDIR /workspace/service/tessera-runtime

COPY service/tessera-runtime/go.mod ./
COPY service/tessera-runtime/main.go ./
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/tessera-runtime .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

WORKDIR /app

COPY --from=build /out/tessera-runtime /app/tessera-runtime

CMD ["/app/tessera-runtime"]
