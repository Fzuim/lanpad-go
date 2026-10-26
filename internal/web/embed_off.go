//go:build !embedclient

package web

import "io/fs"

// embeddedClientFS returns nil for ordinary `go run` / `go build`, which
// serve the Vite output from CLIENT_DIR on disk.
func embeddedClientFS() fs.FS { return nil }
