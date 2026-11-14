package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	aaws "github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/go-sql-driver/mysql"
	"github.com/transparency-dev/tessera"
	taws "github.com/transparency-dev/tessera/storage/aws"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

type env struct {
	host                      string
	port                      int
	awsRegion                 string
	bucket                    string
	dbName                    string
	dbHost                    string
	dbPort                    int
	dbUser                    string
	dbPassword                string
	dbSecretARN               string
	s3Endpoint                string
	s3AccessKeyID             string
	s3SecretAccessKey         string
	s3ForcePathStyle          bool
	logPrivateKey             string
	logName                   string
	publishInterval           time.Duration
	checkpointRepublishPeriod time.Duration
	waitForCheckpointTimeout  time.Duration
}

type addEntryRequest struct {
	SourceKey       string `json:"source_key,omitempty"`
	SourceType      string `json:"source_type"`
	SourceURN       string `json:"source_urn"`
	EntryContentB64 string `json:"entry_content_b64"`
	ContentType     string `json:"content_type,omitempty"`
}

type addEntryResponse struct {
	OK                   bool   `json:"ok"`
	Index                uint64 `json:"index"`
	SourceKey            string `json:"source_key,omitempty"`
	SourceURN            string `json:"source_urn"`
	CheckpointURL        string `json:"checkpoint_url,omitempty"`
	CheckpointTreeSize   uint64 `json:"checkpoint_tree_size,omitempty"`
	CheckpointRootHash   string `json:"checkpoint_root_hash,omitempty"`
	CheckpointNoteSHA256 string `json:"checkpoint_note_sha256,omitempty"`
}

func main() {
	ctx := context.Background()
	cfg := mustLoadEnv()
	cfg = mustResolveDBSecret(ctx, cfg)
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))

	signer, err := getSigner(cfg)
	if err != nil {
		slog.ErrorContext(ctx, "failed to create tessera signer", slog.Any("error", err))
		os.Exit(1)
	}

	driver, err := taws.New(ctx, buildStorageConfig(cfg))
	if err != nil {
		slog.ErrorContext(ctx, "failed to construct tessera aws storage", slog.Any("error", err))
		os.Exit(1)
	}

	appender, shutdown, reader, err := tessera.NewAppender(
		ctx,
		driver,
		tessera.NewAppendOptions().
			WithCheckpointSigner(signer).
			WithCheckpointInterval(cfg.publishInterval).
			WithCheckpointRepublishInterval(cfg.checkpointRepublishPeriod).
			WithBatching(256, time.Second),
	)
	if err != nil {
		slog.ErrorContext(ctx, "failed to create tessera appender", slog.Any("error", err))
		os.Exit(1)
	}
	defer func() {
		_ = shutdown(ctx)
	}()

	listenAddr := fmt.Sprintf("%s:%d", cfg.host, cfg.port)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /v1", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service": "tessera-runtime",
			"purpose": "Run a narrow Tessera-backed append runtime for registry transparency companion experiments.",
			"driver":  "aws-storage-shape",
			"bucket":  cfg.bucket,
			"db_host": cfg.dbHost,
			"db_name": cfg.dbName,
		})
	})
	mux.HandleFunc("POST /v1/entries", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "failed to read request body"})
			return
		}

		var req addEntryRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json payload"})
			return
		}
		if req.SourceType == "" || req.SourceURN == "" || req.EntryContentB64 == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "source_type, source_urn, and entry_content_b64 are required"})
			return
		}
		entryBytes, err := base64.StdEncoding.DecodeString(req.EntryContentB64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "entry_content_b64 must be valid base64"})
			return
		}

		index, err := appender.Add(r.Context(), tessera.NewEntry(entryBytes))()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}

		checkpointURL := fmt.Sprintf("http://%s/checkpoint", listenAddr)
		checkpointInfo, checkpointErr := awaitPublishedCheckpoint(r.Context(), reader, uint64(index.Index), cfg.waitForCheckpointTimeout)
		if checkpointErr != nil {
			slog.Warn("checkpoint not yet published for submitted entry", slog.Any("error", checkpointErr), slog.Uint64("index", uint64(index.Index)))
		}

		writeJSON(w, http.StatusCreated, addEntryResponse{
			OK:        true,
			Index:     uint64(index.Index),
			SourceURN: req.SourceURN,
			SourceKey: req.SourceKey,
			CheckpointURL: func() string {
				if checkpointInfo == nil {
					return ""
				}
				return checkpointURL
			}(),
			CheckpointTreeSize: func() uint64 {
				if checkpointInfo == nil {
					return 0
				}
				return checkpointInfo.treeSize
			}(),
			CheckpointRootHash: func() string {
				if checkpointInfo == nil {
					return ""
				}
				return checkpointInfo.rootHash
			}(),
			CheckpointNoteSHA256: func() string {
				if checkpointInfo == nil {
					return ""
				}
				return checkpointInfo.noteSHA256
			}(),
		})
	})

	mux.HandleFunc("GET /checkpoint", func(w http.ResponseWriter, r *http.Request) {
		checkpoint, err := reader.ReadCheckpoint(r.Context())
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
			return
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(checkpoint)
	})

	h2s := &http2.Server{}
	h1s := &http.Server{
		Addr:              listenAddr,
		Handler:           h2c.NewHandler(mux, h2s),
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := http2.ConfigureServer(h1s, h2s); err != nil {
		slog.ErrorContext(ctx, "failed to configure http2", slog.Any("error", err))
		os.Exit(1)
	}

	slog.Info("tessera runtime listening", slog.String("listen", listenAddr), slog.String("bucket", cfg.bucket))
	if err := h1s.ListenAndServe(); err != nil {
		slog.ErrorContext(ctx, "tessera runtime exited", slog.Any("error", err))
		os.Exit(1)
	}
}

func buildStorageConfig(cfg env) taws.Config {
	mysqlCfg := mysql.Config{
		User:                    cfg.dbUser,
		Passwd:                  cfg.dbPassword,
		Net:                     "tcp",
		Addr:                    fmt.Sprintf("%s:%d", cfg.dbHost, cfg.dbPort),
		DBName:                  cfg.dbName,
		AllowCleartextPasswords: true,
		AllowNativePasswords:    true,
	}

	var sdkConfig *aaws.Config
	var s3Opts func(o *s3.Options)
	if cfg.s3Endpoint != "" {
		s3Opts = func(o *s3.Options) {
			o.BaseEndpoint = aaws.String(cfg.s3Endpoint)
			if cfg.s3AccessKeyID != "" && cfg.s3SecretAccessKey != "" {
				o.Credentials = credentials.NewStaticCredentialsProvider(cfg.s3AccessKeyID, cfg.s3SecretAccessKey, "")
			}
			o.Region = cfg.awsRegion
			o.UsePathStyle = cfg.s3ForcePathStyle
		}
		sdkConfig = &aaws.Config{Region: cfg.awsRegion}
	}

	return taws.Config{
		Bucket:       cfg.bucket,
		SDKConfig:    sdkConfig,
		S3Options:    s3Opts,
		DSN:          mysqlCfg.FormatDSN(),
		MaxIdleConns: 2,
	}
}

func getSigner(cfg env) (note.Signer, error) {
	if cfg.logPrivateKey != "" {
		return note.NewSigner(cfg.logPrivateKey)
	}
	skey, _, err := note.GenerateKey(rand.Reader, cfg.logName)
	if err != nil {
		return nil, err
	}
	slog.Warn("generated ephemeral tessera private key for local development; set TESSERA_LOG_PRIVATE_KEY for stable checkpoints")
	return note.NewSigner(skey)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func mustLoadEnv() env {
	return env{
		host:                      getEnvDefault("HOST", "0.0.0.0"),
		port:                      mustIntEnv("PORT", 2024),
		awsRegion:                 getEnvDefault("TESSERA_AWS_REGION", "us-west-2"),
		bucket:                    mustStringEnv("TESSERA_BUCKET"),
		dbName:                    os.Getenv("TESSERA_DB_NAME"),
		dbHost:                    os.Getenv("TESSERA_DB_HOST"),
		dbPort:                    mustIntEnv("TESSERA_DB_PORT", 3306),
		dbUser:                    os.Getenv("TESSERA_DB_USER"),
		dbPassword:                os.Getenv("TESSERA_DB_PASSWORD"),
		dbSecretARN:               os.Getenv("TESSERA_DB_SECRET_ARN"),
		s3Endpoint:                os.Getenv("TESSERA_S3_ENDPOINT"),
		s3AccessKeyID:             os.Getenv("TESSERA_S3_ACCESS_KEY_ID"),
		s3SecretAccessKey:         os.Getenv("TESSERA_S3_SECRET_ACCESS_KEY"),
		s3ForcePathStyle:          mustBoolEnv("TESSERA_S3_FORCE_PATH_STYLE", true),
		logPrivateKey:             os.Getenv("TESSERA_LOG_PRIVATE_KEY"),
		logName:                   getEnvDefault("TESSERA_LOG_NAME", "agents-registry-dev"),
		publishInterval:           mustDurationEnv("TESSERA_PUBLISH_INTERVAL", 3*time.Second),
		checkpointRepublishPeriod: mustDurationEnv("TESSERA_CHECKPOINT_REPUBLISH_INTERVAL", 30*time.Second),
		waitForCheckpointTimeout:  mustDurationEnv("TESSERA_WAIT_FOR_CHECKPOINT_TIMEOUT", 5*time.Second),
	}
}

func mustResolveDBSecret(ctx context.Context, cfg env) env {
	if cfg.dbSecretARN == "" {
		if cfg.dbName == "" || cfg.dbHost == "" || cfg.dbUser == "" || cfg.dbPassword == "" {
			panic("set either TESSERA_DB_SECRET_ARN or the direct TESSERA_DB_* connection values")
		}
		return cfg
	}

	loadOptions := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(cfg.awsRegion),
	}
	if cfg.s3AccessKeyID != "" && cfg.s3SecretAccessKey != "" {
		loadOptions = append(loadOptions, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.s3AccessKeyID, cfg.s3SecretAccessKey, ""),
		))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		panic(fmt.Sprintf("failed to load AWS config for db secret: %v", err))
	}
	client := secretsmanager.NewFromConfig(awsCfg)
	response, err := client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: aaws.String(cfg.dbSecretARN),
	})
	if err != nil {
		panic(fmt.Sprintf("failed to load db secret: %v", err))
	}
	if response.SecretString == nil {
		panic("db secret is missing SecretString")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(*response.SecretString), &payload); err != nil {
		panic(fmt.Sprintf("db secret must be valid json: %v", err))
	}

	cfg.dbHost = firstSecretString(payload, "host", "hostname", "endpoint")
	cfg.dbName = firstSecretString(payload, "db_name", "dbname", "database", "dbName")
	cfg.dbUser = firstSecretString(payload, "username", "user")
	cfg.dbPassword = firstSecretString(payload, "password")
	cfg.dbPort = firstSecretInt(payload, cfg.dbPort, "port", "db_port")

	if cfg.dbHost == "" || cfg.dbName == "" || cfg.dbUser == "" || cfg.dbPassword == "" {
		panic("db secret must include host, db_name/database, username/user, and password")
	}
	return cfg
}

func firstSecretString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key]; ok {
			if str, ok := value.(string); ok && str != "" {
				return str
			}
		}
	}
	return ""
}

func firstSecretInt(payload map[string]any, fallback int, keys ...string) int {
	for _, key := range keys {
		if value, ok := payload[key]; ok {
			switch typed := value.(type) {
			case float64:
				return int(typed)
			case string:
				if parsed, err := strconv.Atoi(typed); err == nil {
					return parsed
				}
			}
		}
	}
	return fallback
}

func sha256Hex(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

type publishedCheckpoint struct {
	treeSize   uint64
	rootHash   string
	noteSHA256 string
}

func awaitPublishedCheckpoint(ctx context.Context, reader tessera.LogReader, entryIndex uint64, timeout time.Duration) (*publishedCheckpoint, error) {
	if timeout <= 0 {
		return nil, fmt.Errorf("checkpoint wait disabled")
	}
	deadline := time.Now().Add(timeout)
	for {
		checkpointBytes, err := reader.ReadCheckpoint(ctx)
		if err == nil {
			treeSize, rootHash, parseErr := parseCheckpointNote(checkpointBytes)
			if parseErr == nil && treeSize > entryIndex {
				return &publishedCheckpoint{
					treeSize:   treeSize,
					rootHash:   rootHash,
					noteSHA256: sha256Hex(checkpointBytes),
				}, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("published checkpoint not observed before timeout")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func parseCheckpointNote(raw []byte) (uint64, string, error) {
	text := string(raw)
	body := text
	if split := strings.Index(text, "\n\n"); split >= 0 {
		body = text[:split+1]
	}
	lines := strings.Split(strings.ReplaceAll(strings.TrimRight(body, "\n"), "\r", ""), "\n")
	if len(lines) < 3 {
		return 0, "", fmt.Errorf("checkpoint body too short")
	}
	treeSize, err := strconv.ParseUint(lines[1], 10, 64)
	if err != nil {
		return 0, "", err
	}
	return treeSize, lines[2], nil
}

func mustStringEnv(key string) string {
	value := os.Getenv(key)
	if value == "" {
		panic(fmt.Sprintf("missing required env var %s", key))
	}
	return value
}

func getEnvDefault(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func mustIntEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		panic(fmt.Sprintf("invalid integer env var %s: %v", key, err))
	}
	return parsed
}

func mustBoolEnv(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		panic(fmt.Sprintf("invalid boolean env var %s: %v", key, err))
	}
	return parsed
}

func mustDurationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		panic(fmt.Sprintf("invalid duration env var %s: %v", key, err))
	}
	return parsed
}
