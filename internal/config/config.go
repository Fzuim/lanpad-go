// Package config loads LAN Pad's runtime configuration from environment
// variables and an optional .env file next to the executable.
package config

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is the resolved, validated runtime configuration.
type Config struct {
	Root          string
	Port          int
	Host          string
	DataDir       string
	ClientDir     string
	DBFile        string
	AssetsDir     string
	PublicBaseURL string
	HostKey       string
}

// Load resolves the configuration. It reads ROOT/.env first (without
// overriding variables already present in the process environment),
// then materialises the data directories and the host key.
func Load() (*Config, error) {
	root, err := resolveRoot()
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}

	if err := loadDotEnv(filepath.Join(root, ".env")); err != nil {
		return nil, err
	}

	port := 8787
	if raw := strings.TrimSpace(os.Getenv("PORT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 65535 {
			return nil, fmt.Errorf("PORT 无效: %q", raw)
		}
		port = value
	}

	host := strings.TrimSpace(os.Getenv("HOST"))
	if host == "" {
		host = "0.0.0.0"
	}

	dataDir := strings.TrimSpace(os.Getenv("DATA_DIR"))
	if dataDir == "" {
		dataDir = "data"
	}
	if !filepath.IsAbs(dataDir) {
		dataDir = filepath.Join(root, dataDir)
	}
	dataDir = filepath.Clean(dataDir)

	clientDir := strings.TrimSpace(os.Getenv("CLIENT_DIR"))
	if clientDir == "" {
		clientDir = filepath.Join(root, "dist", "client")
	} else if !filepath.IsAbs(clientDir) {
		clientDir = filepath.Join(root, clientDir)
	}
	clientDir = filepath.Clean(clientDir)

	assetsDir := filepath.Join(dataDir, "assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}

	hostKey, err := loadHostKey(dataDir)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		Root:          root,
		Port:          port,
		Host:          host,
		DataDir:       dataDir,
		ClientDir:     clientDir,
		DBFile:        filepath.Join(dataDir, "lanpad.db"),
		AssetsDir:     assetsDir,
		PublicBaseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")), "/"),
		HostKey:       hostKey,
	}
	return cfg, nil
}

// resolveRoot picks the directory that anchors data/ and .env.
//
// LANPAD_ROOT wins when set. Otherwise the current working directory is
// used, which matches `go run`, tests and the Node version's source mode.
// A released binary is normally started from its own directory.
func resolveRoot() (string, error) {
	if raw := strings.TrimSpace(os.Getenv("LANPAD_ROOT")); raw != "" {
		return raw, nil
	}
	return os.Getwd()
}

// loadDotEnv is a deliberately small .env parser: KEY=VALUE lines,
// optional `export `, # comments and single/double quoted values.
// Existing environment variables are never overwritten.
func loadDotEnv(file string) error {
	f, err := os.Open(file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 4*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
	}
	return scanner.Err()
}

// loadHostKey returns HOST_KEY when set, otherwise reads or creates
// data/host-key.txt with a 48-character random hex key.
func loadHostKey(dataDir string) (string, error) {
	if key := strings.TrimSpace(os.Getenv("HOST_KEY")); key != "" {
		return key, nil
	}
	file := filepath.Join(dataDir, "host-key.txt")
	if raw, err := os.ReadFile(file); err == nil {
		if key := strings.TrimSpace(string(raw)); key != "" {
			return key, nil
		}
	}

	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成主机密钥失败: %w", err)
	}
	key := hex.EncodeToString(buf)
	if err := os.WriteFile(file, []byte(key), 0o600); err != nil {
		return "", fmt.Errorf("写入主机密钥失败: %w", err)
	}
	return key, nil
}
