// Package docstore owns LAN Pad's SQLite database: document metadata,
// the Yjs update log, named versions and uploaded image metadata.
//
// It implements ygo's persist.Store contract, so the Go sync server can
// load, append and compact documents without a second database handle.
package docstore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Deln0r/ygo"
	"github.com/Deln0r/ygo/persist"

	_ "modernc.org/sqlite"
)

const (
	// MetaDebounce is how long edits are coalesced before the document's
	// title/state row is refreshed. The update log itself is written
	// synchronously on every edit, so this only affects list metadata.
	MetaDebounce = 800 * time.Millisecond

	// VersionDebounce is how long after the last edit a snapshot is taken.
	// One version per editing burst, not one per keystroke.
	VersionDebounce = 2 * time.Second

	// VersionMaxInterval forces a snapshot during continuous typing that
	// never pauses long enough to hit the debounce.
	VersionMaxInterval = 15 * time.Second

	// KeepVersions is how many snapshots are retained per document.
	KeepVersions = 50

	defaultTitle  = "未命名文档"
	maxTitleRunes = 120
)

// DocMeta is the document summary returned by the REST API.
type DocMeta struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	CreatedAt  int64   `json:"created_at"`
	UpdatedAt  int64   `json:"updated_at"`
	LastEditor *string `json:"last_editor"`
}

// Version is one point-in-time snapshot of a document.
type Version struct {
	ID        int64  `json:"id"`
	CreatedAt int64  `json:"created_at"`
	Title     string `json:"title"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
}

// VersionDetail includes the Yjs state needed to render or restore it.
type VersionDetail struct {
	Version
	State []byte `json:"state"`
}

// Asset is one uploaded image or file attachment.
type Asset struct {
	ID        string `json:"id"`
	DocID     string `json:"doc_id"`
	SHA256    string `json:"sha256"`
	Filename  string `json:"filename"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	MIME      string `json:"mime"`
	Size      int64  `json:"size"`
	Width     *int   `json:"width"`
	Height    *int   `json:"height"`
	CreatedAt int64  `json:"created_at"`
}

// Store wraps the SQLite pool and a small in-memory cache of live Yjs
// documents used to derive the title and full snapshot for the docs table.
type Store struct {
	db *sql.DB

	mu     sync.Mutex
	cache  map[string]*cachedDoc
	closed bool

	versionMu sync.Mutex

	lastEditor func(docID string) string
}

type cachedDoc struct {
	mu     sync.Mutex
	doc    *ygo.Doc
	loaded bool
	dirty  bool
	timer  *time.Timer

	versionDirty      bool
	versionDirtySince time.Time
	versionTimer      *time.Timer
}

// Open opens (or creates) the database and applies the schema.
func Open(file string) (*Store, error) {
	dsn := file + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)

	s := &Store{db: db, cache: make(map[string]*cachedDoc)}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS docs (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '未命名文档',
  state           BLOB,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_editor     TEXT,
  last_version_at INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER
);

CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL,
  state      BLOB NOT NULL,
  title      TEXT,
  sha256     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  filename   TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'image',
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(doc_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_assets_doc ON assets(doc_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only Yjs update log consumed by ygo's persist.Store contract.
CREATE TABLE IF NOT EXISTS doc_updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id      TEXT NOT NULL,
  update_blob BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_updates_doc ON doc_updates(doc_id, id);

-- Older Node builds stored only the compacted snapshot in docs.state.
-- Seed the append-only log from it once so both implementations can read
-- the same database.
INSERT INTO doc_updates (doc_id, update_blob, created_at)
SELECT d.id, d.state, d.updated_at
FROM docs d
WHERE d.state IS NOT NULL
  AND length(d.state) > 0
  AND NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = d.id);
`
	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("初始化数据库失败: %w", err)
	}
	// Older databases predate the content hash column.
	hasSHA, err := s.hasColumn("versions", "sha256")
	if err != nil {
		return err
	}
	if !hasSHA {
		if _, err := s.db.Exec(`ALTER TABLE versions ADD COLUMN sha256 TEXT`); err != nil {
			return fmt.Errorf("升级 versions 表失败: %w", err)
		}
	}
	if err := s.backfillVersionHashes(); err != nil {
		return err
	}
	// Older databases only stored images and had no original file name.
	for _, column := range []struct {
		name string
		ddl  string
	}{
		{"name", `ALTER TABLE assets ADD COLUMN name TEXT NOT NULL DEFAULT ''`},
		{"kind", `ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'`},
	} {
		has, err := s.hasColumn("assets", column.name)
		if err != nil {
			return err
		}
		if has {
			continue
		}
		if _, err := s.db.Exec(column.ddl); err != nil {
			return fmt.Errorf("升级 assets 表失败: %w", err)
		}
	}
	return nil
}

// backfillVersionHashes fills the sha256 column for snapshots written by
// older builds. The row count is bounded by KeepVersions per document.
func (s *Store) backfillVersionHashes() error {
	rows, err := s.db.Query(`SELECT id, state FROM versions WHERE sha256 IS NULL OR sha256 = ''`)
	if err != nil {
		return err
	}
	type pending struct {
		id  int64
		sha string
	}
	var updates []pending
	for rows.Next() {
		var (
			id    int64
			state []byte
		)
		if err := rows.Scan(&id, &state); err != nil {
			rows.Close()
			return err
		}
		updates = append(updates, pending{id: id, sha: digestFromState(state)})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, item := range updates {
		if _, err := s.db.Exec(`UPDATE versions SET sha256 = ? WHERE id = ?`, item.sha, item.id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) hasColumn(table, column string) (bool, error) {
	rows, err := s.db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			cid        int
			name       string
			columnType string
			notNull    int
			defaultV   sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultV, &pk); err != nil {
			return false, err
		}
		if strings.EqualFold(name, column) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// SetLastEditorResolver installs a callback that supplies the most recent
// awareness/user name for a document.
func (s *Store) SetLastEditorResolver(fn func(docID string) string) {
	s.mu.Lock()
	s.lastEditor = fn
	s.mu.Unlock()
}

// CreateDoc inserts a new document whose title lives in the Yjs
// Y.Text('title'), exactly like the Node implementation.
func (s *Store) CreateDoc(id, title string) (DocMeta, error) {
	clean := CleanTitle(title)
	now := time.Now().UnixMilli()

	doc := ygo.NewDoc()
	text := ygo.NewText(doc, "title")
	txn := doc.WriteTxn()
	if err := text.Insert(txn, 0, clean); err != nil {
		txn.Commit()
		return DocMeta{}, fmt.Errorf("初始化标题失败: %w", err)
	}
	txn.Commit()
	state := ygo.EncodeStateAsUpdate(doc)
	digest := documentDigest(doc)

	tx, err := s.db.Begin()
	if err != nil {
		return DocMeta{}, err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO docs (id, title, state, created_at, updated_at, last_version_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, clean, state, now, now, now,
	); err != nil {
		return DocMeta{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO doc_updates (doc_id, update_blob, created_at) VALUES (?, ?, ?)`,
		id, state, now,
	); err != nil {
		return DocMeta{}, err
	}
	// Keep the blank document as the first history entry.
	if _, err := tx.Exec(
		`INSERT INTO versions (doc_id, state, title, sha256, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, state, clean, digest, now,
	); err != nil {
		return DocMeta{}, err
	}
	if err := tx.Commit(); err != nil {
		return DocMeta{}, err
	}
	return DocMeta{ID: id, Title: clean, CreatedAt: now, UpdatedAt: now}, nil
}

// ListDocs returns up to 500 non-deleted documents, newest first.
func (s *Store) ListDocs() ([]DocMeta, error) {
	rows, err := s.db.Query(
		`SELECT id, title, created_at, updated_at, last_editor
		 FROM docs
		 WHERE deleted_at IS NULL
		 ORDER BY updated_at DESC
		 LIMIT 500`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]DocMeta, 0, 16)
	for rows.Next() {
		meta, err := scanDocMeta(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, meta)
	}
	return out, rows.Err()
}

// GetDocMeta returns one non-deleted document, or nil.
func (s *Store) GetDocMeta(id string) (*DocMeta, error) {
	row := s.db.QueryRow(
		`SELECT id, title, created_at, updated_at, last_editor
		 FROM docs
		 WHERE id = ? AND deleted_at IS NULL`,
		id,
	)
	meta, err := scanDocMeta(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &meta, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanDocMeta(row rowScanner) (DocMeta, error) {
	var (
		meta       DocMeta
		lastEditor sql.NullString
	)
	if err := row.Scan(&meta.ID, &meta.Title, &meta.CreatedAt, &meta.UpdatedAt, &lastEditor); err != nil {
		return DocMeta{}, err
	}
	if lastEditor.Valid && strings.TrimSpace(lastEditor.String) != "" {
		value := lastEditor.String
		meta.LastEditor = &value
	}
	return meta, nil
}

// SoftDeleteDoc marks a document deleted. It returns false when the id is
// unknown or already deleted.
func (s *Store) SoftDeleteDoc(id string) (bool, error) {
	result, err := s.db.Exec(
		`UPDATE docs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
		time.Now().UnixMilli(), id,
	)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ListVersions returns a document's snapshots, newest first.
func (s *Store) ListVersions(docID string) ([]Version, error) {
	rows, err := s.db.Query(
		`SELECT id, created_at, COALESCE(title, ''), length(state), COALESCE(sha256, '')
		 FROM versions
		 WHERE doc_id = ?
		 ORDER BY created_at DESC, id DESC
		 LIMIT ?`,
		docID, KeepVersions,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Version, 0, 8)
	for rows.Next() {
		var version Version
		if err := rows.Scan(
			&version.ID,
			&version.CreatedAt,
			&version.Title,
			&version.Size,
			&version.SHA256,
		); err != nil {
			return nil, err
		}
		out = append(out, version)
	}
	return out, rows.Err()
}

// GetVersion returns one snapshot including its Yjs state.
func (s *Store) GetVersion(docID string, versionID int64) (*VersionDetail, error) {
	var detail VersionDetail
	err := s.db.QueryRow(
		`SELECT id, created_at, COALESCE(title, ''), state, COALESCE(sha256, '')
		 FROM versions
		 WHERE doc_id = ? AND id = ?`,
		docID, versionID,
	).Scan(
		&detail.ID,
		&detail.CreatedAt,
		&detail.Title,
		&detail.State,
		&detail.SHA256,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	detail.Size = int64(len(detail.State))
	if detail.SHA256 == "" {
		detail.SHA256 = stateSHA(detail.State)
	}
	return &detail, nil
}

// SnapshotNow captures the current live state immediately. It returns nil
// when the content is identical to the newest snapshot.
func (s *Store) SnapshotNow(ctx context.Context, docID string) (*Version, error) {
	meta, err := s.GetDocMeta(docID)
	if err != nil {
		return nil, err
	}
	if meta == nil {
		return nil, sql.ErrNoRows
	}

	cc, err := s.cachedDoc(ctx, docID)
	if err != nil {
		return nil, err
	}
	cc.mu.Lock()
	state := ygo.EncodeStateAsUpdate(cc.doc)
	title := CleanTitle(ygo.NewText(cc.doc, "title").String())
	digest := documentDigest(cc.doc)
	cc.mu.Unlock()

	return s.insertVersion(docID, state, title, digest, time.Now().UnixMilli())
}

func (s *Store) insertVersion(docID string, state []byte, title, digest string, now int64) (*Version, error) {
	s.versionMu.Lock()
	defer s.versionMu.Unlock()

	var latest string
	err := s.db.QueryRow(
		`SELECT COALESCE(sha256, '') FROM versions
		 WHERE doc_id = ?
		 ORDER BY created_at DESC, id DESC
		 LIMIT 1`,
		docID,
	).Scan(&latest)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if latest == digest {
		return nil, nil
	}

	title = CleanTitle(title)
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	result, err := tx.Exec(
		`INSERT INTO versions (doc_id, state, title, sha256, created_at) VALUES (?, ?, ?, ?, ?)`,
		docID, state, title, digest, now,
	)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`DELETE FROM versions
		 WHERE doc_id = ?
		   AND id NOT IN (
		     SELECT id FROM versions WHERE doc_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
		   )`,
		docID, docID, KeepVersions,
	); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE docs SET last_version_at = ? WHERE id = ?`, now, docID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &Version{
		ID:        id,
		CreatedAt: now,
		Title:     title,
		Size:      int64(len(state)),
		SHA256:    digest,
	}, nil
}

// documentDigest hashes the visible document (title + Tiptap XML content,
// including formatting attributes) rather than the raw CRDT bytes. Two
// states that produce the same visible document therefore dedupe, while a
// real edit always produces a new digest.
func documentDigest(doc *ygo.Doc) string {
	title := ygo.NewText(doc, "title").String()
	content := ygo.NewXmlFragment(doc, "content").ToString()
	if content == "" {
		content = ygo.NewXmlFragment(doc, "default").ToString()
	}
	sum := sha256.Sum256([]byte(title + "\x00" + content))
	return hex.EncodeToString(sum[:])
}

func digestFromState(state []byte) string {
	doc := ygo.NewDoc()
	if err := ygo.ApplyUpdate(doc, state); err != nil {
		return stateSHA(state)
	}
	return documentDigest(doc)
}

func stateSHA(state []byte) string {
	sum := sha256.Sum256(state)
	return hex.EncodeToString(sum[:])
}

// AddAsset inserts image/file metadata, ignoring a duplicate (doc, sha256).
func (s *Store) AddAsset(asset Asset) (Asset, error) {
	if asset.Kind == "" {
		asset.Kind = "image"
	}
	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO assets
		   (id, doc_id, sha256, filename, name, kind, mime, size, width, height, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		asset.ID, asset.DocID, asset.SHA256, asset.Filename, asset.Name, asset.Kind,
		asset.MIME, asset.Size, nullableInt(asset.Width), nullableInt(asset.Height), asset.CreatedAt,
	)
	if err != nil {
		return Asset{}, err
	}
	found, err := s.GetAssetBySHA(asset.DocID, asset.SHA256)
	if err != nil {
		return Asset{}, err
	}
	if found == nil {
		return Asset{}, fmt.Errorf("附件元数据写入失败")
	}
	return *found, nil
}

// GetAssetByFilename looks up attachment metadata for a document.
func (s *Store) GetAssetByFilename(docID, filename string) (*Asset, error) {
	return s.scanAsset(s.db.QueryRow(
		`SELECT id, doc_id, sha256, filename, name, kind, mime, size, width, height, created_at
		 FROM assets
		 WHERE doc_id = ? AND filename = ?`,
		docID, filename,
	))
}

// GetAssetBySHA looks up attachment metadata by content hash.
func (s *Store) GetAssetBySHA(docID, sha string) (*Asset, error) {
	return s.scanAsset(s.db.QueryRow(
		`SELECT id, doc_id, sha256, filename, name, kind, mime, size, width, height, created_at
		 FROM assets
		 WHERE doc_id = ? AND sha256 = ?`,
		docID, sha,
	))
}

func (s *Store) scanAsset(row *sql.Row) (*Asset, error) {
	var (
		asset         Asset
		width, height sql.NullInt64
	)
	err := row.Scan(
		&asset.ID, &asset.DocID, &asset.SHA256, &asset.Filename,
		&asset.Name, &asset.Kind, &asset.MIME, &asset.Size,
		&width, &height, &asset.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if width.Valid {
		v := int(width.Int64)
		asset.Width = &v
	}
	if height.Valid {
		v := int(height.Int64)
		asset.Height = &v
	}
	return &asset, nil
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

// ---------------------------------------------------------------------------
// persist.Store implementation
// ---------------------------------------------------------------------------

var _ persist.Store = (*Store)(nil)

// StoreUpdate appends an update to the log, applies it to the metadata
// cache and schedules a debounced title/state refresh.
func (s *Store) StoreUpdate(ctx context.Context, docName string, update []byte) error {
	if len(update) == 0 {
		return persist.ErrEmptyUpdate
	}

	cc, err := s.cachedDoc(ctx, docName)
	if err != nil {
		return err
	}

	cc.mu.Lock()
	if err := ygo.ApplyUpdate(cc.doc, update); err != nil {
		cc.mu.Unlock()
		return fmt.Errorf("应用 Yjs 更新失败: %w", err)
	}
	cc.dirty = true
	if cc.timer == nil {
		cc.timer = time.AfterFunc(MetaDebounce, func() { s.flushMeta(docName) })
	}
	cc.versionDirty = true
	now := time.Now()
	if cc.versionDirtySince.IsZero() {
		cc.versionDirtySince = now
	}
	delay := VersionDebounce
	if now.Sub(cc.versionDirtySince) >= VersionMaxInterval {
		// Continuous typing: force a checkpoint instead of postponing
		// forever.
		delay = 0
	}
	if cc.versionTimer != nil {
		cc.versionTimer.Stop()
	}
	cc.versionTimer = time.AfterFunc(delay, func() { s.flushVersion(docName) })
	cc.mu.Unlock()

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO doc_updates (doc_id, update_blob, created_at) VALUES (?, ?, ?)`,
		docName, update, time.Now().UnixMilli(),
	)
	if err != nil {
		return fmt.Errorf("写入 Yjs 更新日志失败: %w", err)
	}
	return nil
}

// GetUpdates returns every stored update, oldest first. Legacy documents
// that only have docs.state are promoted to a one-entry log.
func (s *Store) GetUpdates(ctx context.Context, docName string) ([][]byte, error) {
	updates, err := s.queryUpdates(ctx, docName)
	if err != nil {
		return nil, err
	}
	if len(updates) > 0 {
		return updates, nil
	}

	var state []byte
	err = s.db.QueryRowContext(ctx, `SELECT state FROM docs WHERE id = ?`, docName).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && len(state) == 0) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO doc_updates (doc_id, update_blob, created_at) VALUES (?, ?, ?)`,
		docName, state, time.Now().UnixMilli(),
	); err != nil {
		return nil, err
	}
	return [][]byte{state}, nil
}

func (s *Store) queryUpdates(ctx context.Context, docName string) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT update_blob FROM doc_updates WHERE doc_id = ? ORDER BY id ASC`, docName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out [][]byte
	for rows.Next() {
		var blob []byte
		if err := rows.Scan(&blob); err != nil {
			return nil, err
		}
		out = append(out, blob)
	}
	return out, rows.Err()
}

// Flush compacts the update log into one snapshot and refreshes
// docs.state. It uses BEGIN IMMEDIATE so a concurrent edit either lands
// before the read or after the commit, never in a torn gap.
func (s *Store) Flush(ctx context.Context, docName string) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("压缩事务开启失败: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	rows, err := conn.QueryContext(ctx,
		`SELECT update_blob FROM doc_updates WHERE doc_id = ? ORDER BY id ASC`, docName)
	if err != nil {
		return err
	}
	var updates [][]byte
	for rows.Next() {
		var blob []byte
		if err := rows.Scan(&blob); err != nil {
			rows.Close()
			return err
		}
		updates = append(updates, blob)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(updates) > 0 {
		snapshot := updates[0]
		if len(updates) > 1 {
			merged, err := persist.MergeUpdates(updates)
			if err != nil {
				return fmt.Errorf("压缩 Yjs 更新失败: %w", err)
			}
			snapshot = merged
			if _, err := conn.ExecContext(ctx,
				`DELETE FROM doc_updates WHERE doc_id = ?`, docName); err != nil {
				return err
			}
			if _, err := conn.ExecContext(ctx,
				`INSERT INTO doc_updates (doc_id, update_blob, created_at) VALUES (?, ?, ?)`,
				docName, snapshot, time.Now().UnixMilli()); err != nil {
				return err
			}
		}
		if _, err := conn.ExecContext(ctx,
			`UPDATE docs SET state = ? WHERE id = ?`, snapshot, docName); err != nil {
			return err
		}
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	committed = true
	return nil
}

// DocumentExists reports whether the document is visible in the docs table.
func (s *Store) DocumentExists(ctx context.Context, docName string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NULL LIMIT 1`, docName).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ListDocuments returns the ids of all non-deleted documents.
func (s *Store) ListDocuments(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM docs WHERE deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ClearDocument removes a document's update log and snapshot.
func (s *Store) ClearDocument(ctx context.Context, docName string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM doc_updates WHERE doc_id = ?`, docName); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE docs SET state = NULL WHERE id = ?`, docName)
	return err
}

// Close stops pending metadata timers and closes the database.
func (s *Store) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	caches := make(map[string]*cachedDoc, len(s.cache))
	for name, cc := range s.cache {
		caches[name] = cc
	}
	s.mu.Unlock()

	for name := range caches {
		s.flushMeta(name)
		s.flushVersion(name)
	}
	for _, cc := range caches {
		cc.mu.Lock()
		if cc.timer != nil {
			cc.timer.Stop()
			cc.timer = nil
		}
		if cc.versionTimer != nil {
			cc.versionTimer.Stop()
			cc.versionTimer = nil
		}
		cc.mu.Unlock()
	}
	return s.db.Close()
}

// FlushMetaAll writes all dirty document metadata. Call it before Close
// so titles and updated_at are current even when timers are pending.
func (s *Store) FlushMetaAll() {
	s.mu.Lock()
	names := make([]string, 0, len(s.cache))
	for name := range s.cache {
		names = append(names, name)
	}
	s.mu.Unlock()
	for _, name := range names {
		s.flushMeta(name)
	}
}

// ---------------------------------------------------------------------------
// metadata cache
// ---------------------------------------------------------------------------

func (s *Store) cachedDoc(ctx context.Context, docName string) (*cachedDoc, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("数据库已关闭")
	}
	cc := s.cache[docName]
	if cc == nil {
		cc = &cachedDoc{}
		s.cache[docName] = cc
	}
	s.mu.Unlock()

	cc.mu.Lock()
	defer cc.mu.Unlock()
	if !cc.loaded {
		updates, err := s.queryUpdates(ctx, docName)
		if err != nil {
			return nil, err
		}
		doc := ygo.NewDoc()
		for _, update := range updates {
			if err := ygo.ApplyUpdate(doc, update); err != nil {
				return nil, fmt.Errorf("加载 Yjs 更新失败: %w", err)
			}
		}
		cc.doc = doc
		cc.loaded = true
	}
	return cc, nil
}

func (s *Store) flushMeta(docName string) {
	s.mu.Lock()
	closed := s.closed
	cc := s.cache[docName]
	resolver := s.lastEditor
	s.mu.Unlock()
	if cc == nil {
		return
	}

	cc.mu.Lock()
	if !cc.dirty || cc.doc == nil {
		if cc.timer != nil {
			cc.timer = nil
		}
		cc.mu.Unlock()
		return
	}
	state := ygo.EncodeStateAsUpdate(cc.doc)
	title := CleanTitle(ygo.NewText(cc.doc, "title").String())
	cc.dirty = false
	cc.timer = nil
	cc.mu.Unlock()

	now := time.Now().UnixMilli()
	var editor any
	if resolver != nil {
		if name := strings.TrimSpace(resolver(docName)); name != "" {
			editor = truncateRunes(name, 40)
		}
	}

	if _, err := s.db.Exec(
		`UPDATE docs
		 SET state = ?, title = ?, updated_at = ?, last_editor = COALESCE(?, last_editor)
		 WHERE id = ?`,
		state, title, now, editor, docName,
	); err != nil {
		if !closed {
			fmt.Fprintf(os.Stderr, "[db] 保存文档元数据失败 %s: %v\n", docName, err)
		}
	}

	cc.mu.Lock()
	if cc.dirty && cc.timer == nil && !closed {
		cc.timer = time.AfterFunc(MetaDebounce, func() { s.flushMeta(docName) })
	}
	cc.mu.Unlock()
}

// flushVersion writes a snapshot after an editing burst pauses. Edits
// arriving during the write mark the document dirty again and schedule
// another debounce; continuous typing is checkpointed by
// VersionMaxInterval in StoreUpdate.
func (s *Store) flushVersion(docName string) {
	s.mu.Lock()
	closed := s.closed
	cc := s.cache[docName]
	s.mu.Unlock()
	if cc == nil {
		return
	}

	cc.mu.Lock()
	if !cc.versionDirty || cc.doc == nil {
		cc.versionTimer = nil
		cc.mu.Unlock()
		return
	}
	state := ygo.EncodeStateAsUpdate(cc.doc)
	title := CleanTitle(ygo.NewText(cc.doc, "title").String())
	digest := documentDigest(cc.doc)
	cc.versionDirty = false
	cc.versionDirtySince = time.Time{}
	cc.versionTimer = nil
	cc.mu.Unlock()

	_, insertErr := s.insertVersion(docName, state, title, digest, time.Now().UnixMilli())
	if insertErr != nil && !closed {
		fmt.Fprintf(os.Stderr, "[db] 保存文档版本失败 %s: %v\n", docName, insertErr)
	}

	cc.mu.Lock()
	if insertErr != nil {
		// Retry after the next debounce instead of silently dropping it.
		cc.versionDirty = true
		cc.versionDirtySince = time.Now()
	}
	if cc.versionDirty && cc.versionTimer == nil && !closed {
		cc.versionTimer = time.AfterFunc(VersionDebounce, func() { s.flushVersion(docName) })
	}
	cc.mu.Unlock()
}

// FlushVersions snapshots every document with unsaved version changes.
func (s *Store) FlushVersions() {
	s.mu.Lock()
	names := make([]string, 0, len(s.cache))
	for name := range s.cache {
		names = append(names, name)
	}
	s.mu.Unlock()
	for _, name := range names {
		s.flushVersion(name)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// CleanTitle trims, caps at 120 characters and applies the default title.
func CleanTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return defaultTitle
	}
	return truncateRunes(title, maxTitleRunes)
}

func truncateRunes(value string, max int) string {
	if max <= 0 || utf8.RuneCountInString(value) <= max {
		return value
	}
	runes := []rune(value)
	return string(runes[:max])
}
