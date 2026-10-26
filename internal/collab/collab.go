// Package collab wires the ygo Yjs sync server into LAN Pad: document
// validation, presence counts, read-only viewers and last-editor tracking.
package collab

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Deln0r/ygo/server"

	"github.com/Fzuim/lanpad-go/internal/docstore"
	"github.com/Fzuim/lanpad-go/internal/ids"
)

// Manager owns the WebSocket sync server and the in-memory presence state.
type Manager struct {
	srv   *server.Server
	store *docstore.Store

	mu         sync.Mutex
	online     map[string]map[string]struct{}
	lastEditor map[string]string
}

// New creates the ygo server. The store is the same SQLite database used
// by the REST API, so Yjs updates and document metadata stay in one file.
func New(store *docstore.Store) *Manager {
	m := &Manager{
		store:      store,
		online:     make(map[string]map[string]struct{}),
		lastEditor: make(map[string]string),
	}

	m.srv = server.New(server.Options{
		Store: store,

		// The Node version performs no Origin check and has no auth. Keep
		// parity for the trusted-LAN use case (and for the Vite dev proxy).
		OriginPatterns: []string{"*"},

		MaxConnsPerDoc:    128,
		MaxDocs:           5000,
		MaxIdleDocs:       200,
		DocIdleTimeout:    2 * time.Minute,
		ReadLimit:         32 << 20,
		WriteTimeout:      20 * time.Second,
		MaxSendQueueBytes: 32 << 20,

		// Keep the append-only update log bounded during long editing
		// sessions; FlushEvery compacts it on the read goroutine.
		FlushEvery: 200,

		// "?mode=view" is enforced server-side here, unlike the Node
		// version where it was only a UI hint.
		ReadOnly: func(_ string, r *http.Request) bool {
			return r.URL.Query().Get("mode") == "view"
		},

		OnConnect: func(connID, docName string, r *http.Request) error {
			if !ids.IsDocID(docName) {
				return errors.New("文档不存在")
			}
			meta, err := store.GetDocMeta(docName)
			if err != nil {
				return err
			}
			if meta == nil {
				return errors.New("文档不存在")
			}
			if name := sanitizeName(r.URL.Query().Get("user")); name != "" &&
				r.URL.Query().Get("mode") != "view" {
				m.setLastEditor(docName, name)
			}
			m.addOnline(docName, connID)
			return nil
		},

		OnDisconnect: func(connID, docName string) {
			m.removeOnline(docName, connID)
			// Capture the final state when the last editor leaves, so a
			// short session still leaves a history entry.
			if m.OnlineCount(docName) == 0 {
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					_, _ = store.SnapshotNow(ctx, docName)
				}()
			}
		},
	})

	store.SetLastEditorResolver(m.LastEditor)
	return m
}

// Handler serves the WebSocket upgrade. Mount it at "/collab/".
func (m *Manager) Handler() http.Handler { return m.srv.Handler() }

// Close flushes resident documents and stops the sync server.
func (m *Manager) Close(ctx context.Context) error { return m.srv.Close(ctx) }

// OnlineCount reports how many live sockets a document has.
func (m *Manager) OnlineCount(docID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.online[docID])
}

// Connections reports the total number of live sockets.
func (m *Manager) Connections() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	total := 0
	for _, conns := range m.online {
		total += len(conns)
	}
	return total
}

// LastEditor returns the most recent user name seen for a document.
func (m *Manager) LastEditor(docID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastEditor[docID]
}

func (m *Manager) setLastEditor(docID, name string) {
	m.mu.Lock()
	m.lastEditor[docID] = name
	m.mu.Unlock()
}

func (m *Manager) addOnline(docID, connID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	set := m.online[docID]
	if set == nil {
		set = make(map[string]struct{})
		m.online[docID] = set
	}
	set[connID] = struct{}{}
}

func (m *Manager) removeOnline(docID, connID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	set := m.online[docID]
	if set == nil {
		return
	}
	delete(set, connID)
	if len(set) == 0 {
		delete(m.online, docID)
	}
}

// sanitizeName mirrors the browser's name cleanup: no control characters,
// no angle brackets and at most 32 characters.
func sanitizeName(value string) string {
	value = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || r == 0x7f:
			return -1
		case r == '<' || r == '>':
			return -1
		default:
			return r
		}
	}, value)
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 32 {
		value = string(runes[:32])
	}
	return value
}
