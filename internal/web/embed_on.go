//go:build embedclient

package web

import (
	"embed"
	"io/fs"
)

// embeddedClient is populated by scripts/build-go.mjs, which copies
// dist/client into internal/web/dist before building with -tags embedclient.
//
//go:embed all:dist
var embeddedClient embed.FS

func embeddedClientFS() fs.FS {
	sub, err := fs.Sub(embeddedClient, "dist")
	if err != nil {
		return nil
	}
	return sub
}
