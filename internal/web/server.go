// Package web exposes LAN Pad's HTTP API, image endpoint and the built
// single-page client.
package web

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Fzuim/lanpad-go/internal/assets"
	"github.com/Fzuim/lanpad-go/internal/collab"
	"github.com/Fzuim/lanpad-go/internal/config"
	"github.com/Fzuim/lanpad-go/internal/docstore"
	"github.com/Fzuim/lanpad-go/internal/ids"
	"github.com/Fzuim/lanpad-go/internal/network"
)

// Server bundles the dependencies of the HTTP layer.
type Server struct {
	cfg       *config.Config
	store     *docstore.Store
	collab    *collab.Manager
	clientFS  fs.FS
	startedAt time.Time
	handler   http.Handler
}

// New builds the router.
func New(cfg *config.Config, store *docstore.Store, manager *collab.Manager) *Server {
	clientFS := embeddedClientFS()
	if clientFS == nil {
		// Development / `go run` mode: serve the Vite build from disk.
		clientFS = os.DirFS(cfg.ClientDir)
	}

	s := &Server{
		cfg:       cfg,
		store:     store,
		collab:    manager,
		clientFS:  clientFS,
		startedAt: time.Now(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/network", s.handleNetwork)
	mux.HandleFunc("GET /api/docs", s.handleListDocs)
	mux.HandleFunc("POST /api/docs", s.handleCreateDoc)
	mux.HandleFunc("GET /api/docs/{id}", s.handleGetDoc)
	mux.HandleFunc("DELETE /api/docs/{id}", s.handleDeleteDoc)
	mux.HandleFunc("GET /api/docs/{id}/versions", s.handleListVersions)
	mux.HandleFunc("POST /api/docs/{id}/versions", s.handleSnapshotVersion)
	mux.HandleFunc("GET /api/docs/{id}/versions/{versionId}", s.handleGetVersion)
	mux.HandleFunc("POST /api/docs/{id}/assets", s.handleUploadAsset)
	mux.HandleFunc("POST /api/docs/{id}/attachments", s.handleUploadAttachment)
	mux.HandleFunc("GET /assets/{docId}/{filename}", s.handleAsset)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "接口不存在")
	})
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文件不存在")
	})
	mux.Handle("/collab/", manager.Handler())
	mux.HandleFunc("/", s.handleSPA)

	s.handler = s.recoverer(s.securityHeaders(mux))
	return s
}

// Handler returns the complete middleware-wrapped handler.
func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss: data: blob:; font-src 'self' data:; base-uri 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("[http] panic %s %s: %v", r.Method, r.URL.Path, recovered)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) network() network.Info {
	return network.Discover(s.cfg.Port, s.cfg.PublicBaseURL)
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

type docResponse struct {
	docstore.DocMeta
	Online int    `json:"online"`
	URL    string `json:"url,omitempty"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	docs, err := s.store.ListDocs()
	if err != nil {
		log.Printf("[api] health list docs: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"uptime":      int(time.Since(s.startedAt).Seconds()),
		"docs":        len(docs),
		"connections": s.collab.Connections(),
	})
}

func (s *Server) handleNetwork(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.network())
}

func (s *Server) handleListDocs(w http.ResponseWriter, r *http.Request) {
	docs, err := s.store.ListDocs()
	if err != nil {
		serverError(w, "读取文档列表", err)
		return
	}
	base := strings.TrimRight(r.URL.Query().Get("base"), "/")
	out := make([]docResponse, 0, len(docs))
	for _, doc := range docs {
		item := docResponse{DocMeta: doc, Online: s.collab.OnlineCount(doc.ID)}
		if base != "" {
			item.URL = base + "/d/" + doc.ID
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"docs": out})
}

func (s *Server) handleCreateDoc(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "请求内容不是合法 JSON")
		return
	}

	id, err := ids.NewDocID()
	if err != nil {
		serverError(w, "生成文档 ID", err)
		return
	}
	doc, err := s.store.CreateDoc(id, body.Title)
	if err != nil {
		serverError(w, "创建文档", err)
		return
	}

	info := s.network()
	resp := docResponse{DocMeta: doc, Online: 0, URL: info.Primary + "/d/" + doc.ID}
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleGetDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !ids.IsDocID(id) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	doc, err := s.store.GetDocMeta(id)
	if err != nil {
		serverError(w, "读取文档", err)
		return
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	info := s.network()
	writeJSON(w, http.StatusOK, docResponse{
		DocMeta: *doc,
		Online:  s.collab.OnlineCount(doc.ID),
		URL:     info.Primary + "/d/" + doc.ID,
	})
}

func (s *Server) handleDeleteDoc(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("X-Host-Key")
	if subtle.ConstantTimeCompare([]byte(key), []byte(s.cfg.HostKey)) != 1 {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "需要主机密钥")
		return
	}
	id := r.PathValue("id")
	if !ids.IsDocID(id) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	deleted, err := s.store.SoftDeleteDoc(id)
	if err != nil {
		serverError(w, "删除文档", err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) docOr404(w http.ResponseWriter, r *http.Request) (*docstore.DocMeta, bool) {
	id := r.PathValue("id")
	if !ids.IsDocID(id) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return nil, false
	}
	doc, err := s.store.GetDocMeta(id)
	if err != nil {
		serverError(w, "读取文档", err)
		return nil, false
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return nil, false
	}
	return doc, true
}

func (s *Server) handleListVersions(w http.ResponseWriter, r *http.Request) {
	doc, ok := s.docOr404(w, r)
	if !ok {
		return
	}
	versions, err := s.store.ListVersions(doc.ID)
	if err != nil {
		serverError(w, "读取版本列表", err)
		return
	}
	if len(versions) == 0 {
		// Documents created by the Node build (or before versioning) get a
		// baseline snapshot the first time history is opened.
		if version, snapErr := s.store.SnapshotNow(r.Context(), doc.ID); snapErr == nil && version != nil {
			versions = []docstore.Version{*version}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
}

func (s *Server) handleGetVersion(w http.ResponseWriter, r *http.Request) {
	doc, ok := s.docOr404(w, r)
	if !ok {
		return
	}
	versionID, err := strconv.ParseInt(r.PathValue("versionId"), 10, 64)
	if err != nil || versionID <= 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "版本不存在")
		return
	}
	version, err := s.store.GetVersion(doc.ID, versionID)
	if err != nil {
		serverError(w, "读取版本", err)
		return
	}
	if version == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "版本不存在")
		return
	}
	writeJSON(w, http.StatusOK, version)
}

func (s *Server) handleSnapshotVersion(w http.ResponseWriter, r *http.Request) {
	doc, ok := s.docOr404(w, r)
	if !ok {
		return
	}
	version, err := s.store.SnapshotNow(r.Context(), doc.ID)
	if err != nil {
		serverError(w, "保存版本", err)
		return
	}
	if version == nil {
		writeJSON(w, http.StatusOK, map[string]any{"created": false})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"created": true, "version": version})
}

func (s *Server) handleUploadAsset(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if !ids.IsDocID(docID) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	doc, err := s.store.GetDocMeta(docID)
	if err != nil {
		serverError(w, "读取文档", err)
		return
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, assets.MaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		if requestTooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, "LIMIT_FILE_SIZE", "图片不能超过 15MB")
			return
		}
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "图片上传失败")
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "NO_FILE", "没有收到图片文件")
		return
	}
	defer file.Close()
	if header.Size > assets.MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "LIMIT_FILE_SIZE", "图片不能超过 15MB")
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, assets.MaxUploadBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "图片上传失败")
		return
	}
	if len(data) > assets.MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "LIMIT_FILE_SIZE", "图片不能超过 15MB")
		return
	}

	result, err := assets.Save(
		s.store,
		s.cfg.AssetsDir,
		docID,
		header.Filename,
		data,
		r.FormValue("width"),
		r.FormValue("height"),
	)
	if errors.Is(err, assets.ErrUnsupported) {
		writeError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "只支持 PNG / JPEG / GIF / WebP 图片")
		return
	}
	if err != nil {
		serverError(w, "保存图片", err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleUploadAttachment(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if !ids.IsDocID(docID) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	doc, err := s.store.GetDocMeta(docID)
	if err != nil {
		serverError(w, "读取文档", err)
		return
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, assets.MaxAttachmentBytes+(2<<20))
	if err := r.ParseMultipartForm(assets.MaxAttachmentBytes + (2 << 20)); err != nil {
		if requestTooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, "LIMIT_FILE_SIZE", "附件不能超过 50MB")
			return
		}
		log.Printf("[upload] attachment parse: %v", err)
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "附件上传失败")
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "NO_FILE", "没有收到附件文件")
		return
	}
	defer file.Close()
	if header.Size > assets.MaxAttachmentBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "LIMIT_FILE_SIZE", "附件不能超过 50MB")
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, assets.MaxAttachmentBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "附件上传失败")
		return
	}
	if len(data) > assets.MaxAttachmentBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "LIMIT_FILE_SIZE", "附件不能超过 50MB")
		return
	}

	result, err := assets.SaveAttachment(
		s.store,
		s.cfg.AssetsDir,
		docID,
		header.Filename,
		data,
	)
	if err != nil {
		serverError(w, "保存附件", err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("docId")
	filename := r.PathValue("filename")
	if !ids.IsDocID(docID) || !ids.IsAssetFile(filename) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文件不存在")
		return
	}

	asset, err := s.store.GetAssetByFilename(docID, filename)
	if err != nil {
		serverError(w, "读取文件", err)
		return
	}
	if asset == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文件不存在")
		return
	}

	full := filepath.Join(s.cfg.AssetsDir, docID, filename)
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文件不存在")
		return
	}

	name := asset.Name
	if name == "" {
		name = filename
	}
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" || !inlinePreview(asset.MIME) {
		disposition = "attachment"
	}
	if value := mime.FormatMediaType(disposition, map[string]string{"filename": name}); value != "" {
		w.Header().Set("Content-Disposition", value)
	}

	w.Header().Set("Content-Type", asset.MIME)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, full)
}

func requestTooLarge(err error) bool {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return true
	}
	return strings.Contains(err.Error(), "request body too large")
}

func inlinePreview(mimeType string) bool {
	switch strings.ToLower(strings.Split(mimeType, ";")[0]) {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
		"application/pdf", "text/plain", "text/markdown", "application/json", "text/csv":
		return true
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// static client
// ---------------------------------------------------------------------------

func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "接口不存在")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/assets/") {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "接口不存在")
		return
	}

	if _, err := fs.Stat(s.clientFS, "index.html"); err != nil {
		writeError(w, http.StatusServiceUnavailable, "CLIENT_NOT_BUILT",
			"前端还没构建：请先运行 npm run build（或只运行 vite build）")
		return
	}

	clean := path.Clean("/" + r.URL.Path)
	rel := strings.TrimPrefix(clean, "/")
	if rel == "" || rel == "." {
		s.serveClientFile(w, r, "index.html", true)
		return
	}
	if !fs.ValidPath(rel) {
		http.NotFound(w, r)
		return
	}
	if info, err := fs.Stat(s.clientFS, rel); err == nil && !info.IsDir() {
		s.serveClientFile(w, r, rel, false)
		return
	}
	// Unknown path without an extension: let the SPA router handle it.
	if path.Ext(rel) == "" {
		s.serveClientFile(w, r, "index.html", true)
		return
	}
	http.NotFound(w, r)
}

func (s *Server) serveClientFile(w http.ResponseWriter, r *http.Request, name string, isIndex bool) {
	data, err := fs.ReadFile(s.clientFS, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	ext := strings.ToLower(path.Ext(name))
	if isIndex {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		if contentType := mime.TypeByExtension(ext); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		if strings.HasPrefix(name, "static/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("[http] encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body errorBody
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(w, status, body)
}

func serverError(w http.ResponseWriter, action string, err error) {
	log.Printf("[http] %s: %v", action, err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
}
