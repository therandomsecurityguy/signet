FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS build

WORKDIR /workspace/service/tessera-runtime

COPY service/tessera-runtime/go.mod ./
COPY service/tessera-runtime/main.go ./
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/tessera-runtime .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

WORKDIR /app

COPY --from=build /out/tessera-runtime /app/tessera-runtime

CMD ["/app/tessera-runtime"]
