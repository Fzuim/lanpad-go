// Package assets validates and stores pasted screenshots and file
// attachments under data/assets/<docID>/.
package assets

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Fzuim/lanpad-go/internal/docstore"
)

// ErrUnsupported is returned for bytes that are not a supported image.
var ErrUnsupported = errors.New("只支持 PNG / JPEG / GIF / WebP 图片")

const (
	// MaxUploadBytes matches the Node server's 15 MiB image limit.
	MaxUploadBytes = 15 * 1024 * 1024

	// MaxAttachmentBytes is the generic attachment limit.
	MaxAttachmentBytes = 50 * 1024 * 1024
)

var safeExt = regexp.MustCompile(`^[a-z0-9]{1,10}$`)

// ImageInfo describes a recognised image format.
type ImageInfo struct {
	MIME string
	Ext  string
}

// Result is the JSON payload returned by the upload endpoints.
type Result struct {
	URL    string `json:"url"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	MIME   string `json:"mime"`
	Kind   string `json:"kind"`
	Ext    string `json:"ext"`
	Width  *int   `json:"width"`
	Height *int   `json:"height"`
}

// DetectImage sniffs PNG, JPEG, GIF and WebP magic bytes.
func DetectImage(buf []byte) (ImageInfo, bool) {
	switch {
	case len(buf) >= 8 &&
		buf[0] == 0x89 && buf[1] == 'P' && buf[2] == 'N' && buf[3] == 'G' &&
		buf[4] == 0x0d && buf[5] == 0x0a && buf[6] == 0x1a && buf[7] == 0x0a:
		return ImageInfo{MIME: "image/png", Ext: "png"}, true
	case len(buf) >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff:
		return ImageInfo{MIME: "image/jpeg", Ext: "jpg"}, true
	}

	head6 := string(buf[:min(6, len(buf))])
	if head6 == "GIF87a" || head6 == "GIF89a" {
		return ImageInfo{MIME: "image/gif", Ext: "gif"}, true
	}
	if len(buf) >= 12 && string(buf[0:4]) == "RIFF" && string(buf[8:12]) == "WEBP" {
		return ImageInfo{MIME: "image/webp", Ext: "webp"}, true
	}
	return ImageInfo{}, false
}

// Save validates an image, writes it under assetsDir/<docID>/ and records
// its metadata. Duplicate content is deduplicated by SHA-256.
func Save(
	store *docstore.Store,
	assetsDir string,
	docID string,
	originalName string,
	buf []byte,
	widthRaw string,
	heightRaw string,
) (Result, error) {
	info, ok := DetectImage(buf)
	if !ok {
		return Result{}, ErrUnsupported
	}

	hash := hashBytes(buf)
	filename := hash + "." + info.Ext
	name := sanitizeName(originalName, "截图."+info.Ext)

	existing, err := store.GetAssetBySHA(docID, hash)
	if err != nil {
		return Result{}, err
	}
	if existing != nil {
		return Result{
			URL:    assetURL(docID, existing.Filename),
			Name:   name,
			Size:   existing.Size,
			MIME:   existing.MIME,
			Kind:   "image",
			Ext:    info.Ext,
			Width:  existing.Width,
			Height: existing.Height,
		}, nil
	}

	if err := writeFile(assetsDir, docID, filename, buf); err != nil {
		return Result{}, err
	}

	width := parseDimension(widthRaw)
	height := parseDimension(heightRaw)
	asset, err := store.AddAsset(docstore.Asset{
		ID:        newID(),
		DocID:     docID,
		SHA256:    hash,
		Filename:  filename,
		Name:      name,
		Kind:      "image",
		MIME:      info.MIME,
		Size:      int64(len(buf)),
		Width:     width,
		Height:    height,
		CreatedAt: nowMillis(),
	})
	if err != nil {
		return Result{}, err
	}

	return Result{
		URL:    assetURL(docID, asset.Filename),
		Name:   name,
		Size:   asset.Size,
		MIME:   asset.MIME,
		Kind:   "image",
		Ext:    info.Ext,
		Width:  asset.Width,
		Height: asset.Height,
	}, nil
}

// SaveAttachment stores any file up to MaxAttachmentBytes.
func SaveAttachment(
	store *docstore.Store,
	assetsDir string,
	docID string,
	originalName string,
	buf []byte,
) (Result, error) {
	if len(buf) == 0 {
		return Result{}, errors.New("文件是空的")
	}

	ext := fileExtension(originalName, buf)
	hash := hashBytes(buf)
	filename := hash + "." + ext
	name := sanitizeName(originalName, "附件."+ext)

	existing, err := store.GetAssetBySHA(docID, hash)
	if err != nil {
		return Result{}, err
	}
	if existing != nil {
		return Result{
			URL:  assetURL(docID, existing.Filename),
			Name: name,
			Size: existing.Size,
			MIME: existing.MIME,
			Kind: "file",
			Ext:  ext,
		}, nil
	}

	if err := writeFile(assetsDir, docID, filename, buf); err != nil {
		return Result{}, err
	}

	mimeType := mimeFor(ext, buf)
	asset, err := store.AddAsset(docstore.Asset{
		ID:        newID(),
		DocID:     docID,
		SHA256:    hash,
		Filename:  filename,
		Name:      name,
		Kind:      "file",
		MIME:      mimeType,
		Size:      int64(len(buf)),
		CreatedAt: nowMillis(),
	})
	if err != nil {
		return Result{}, err
	}

	return Result{
		URL:  assetURL(docID, asset.Filename),
		Name: name,
		Size: asset.Size,
		MIME: asset.MIME,
		Kind: "file",
		Ext:  ext,
	}, nil
}

func hashBytes(buf []byte) string {
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:])
}

func newID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf)
}

func assetURL(docID, filename string) string {
	return "/assets/" + docID + "/" + filename
}

func writeFile(assetsDir, docID, filename string, buf []byte) error {
	dir := filepath.Join(assetsDir, docID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建附件目录失败: %w", err)
	}
	full := filepath.Join(dir, filename)
	if _, err := os.Stat(full); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(full, buf, 0o644); err != nil {
			return fmt.Errorf("保存附件失败: %w", err)
		}
	}
	return nil
}

// sanitizeName keeps the original display/download name but strips path
// separators, control characters and characters Windows cannot use.
func sanitizeName(raw, fallback string) string {
	name := strings.ReplaceAll(raw, "\\", "/")
	name = path.Base(name)
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || r == 0x7f:
			return -1
		case strings.ContainsRune(`<>:"/|?*`, r):
			return '_'
		default:
			return r
		}
	}, name)
	name = strings.TrimSpace(strings.Trim(name, "."))
	if name == "" {
		name = fallback
	}
	runes := []rune(name)
	if len(runes) > 180 {
		name = string(runes[:180])
	}
	return name
}

func fileExtension(name string, buf []byte) string {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(strings.ReplaceAll(name, "\\", "/"))), ".")
	if safeExt.MatchString(ext) {
		return ext
	}
	return extensionForMIME(http.DetectContentType(buf))
}

func extensionForMIME(mimeType string) string {
	base := strings.Split(strings.ToLower(mimeType), ";")[0]
	switch base {
	case "application/pdf":
		return "pdf"
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	case "text/plain":
		return "txt"
	case "application/json":
		return "json"
	case "application/zip":
		return "zip"
	}
	if extensions, err := mime.ExtensionsByType(base); err == nil && len(extensions) > 0 {
		if ext := strings.TrimPrefix(strings.ToLower(extensions[0]), "."); safeExt.MatchString(ext) {
			return ext
		}
	}
	return "bin"
}

var mimeByExtension = map[string]string{
	"rar":  "application/vnd.rar",
	"zip":  "application/zip",
	"7z":   "application/x-7z-compressed",
	"tar":  "application/x-tar",
	"gz":   "application/gzip",
	"tgz":  "application/gzip",
	"bz2":  "application/x-bzip2",
	"xz":   "application/x-xz",
	"pdf":  "application/pdf",
	"doc":  "application/msword",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"rtf":  "application/rtf",
	"odt":  "application/vnd.oasis.opendocument.text",
	"xls":  "application/vnd.ms-excel",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"csv":  "text/csv; charset=utf-8",
	"ods":  "application/vnd.oasis.opendocument.spreadsheet",
	"ppt":  "application/vnd.ms-powerpoint",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"odp":  "application/vnd.oasis.opendocument.presentation",
	"txt":  "text/plain; charset=utf-8",
	"md":   "text/markdown; charset=utf-8",
	"log":  "text/plain; charset=utf-8",
	"json": "application/json",
	"xml":  "application/xml",
	"html": "text/html; charset=utf-8",
	"css":  "text/css; charset=utf-8",
	"js":   "text/javascript; charset=utf-8",
	"ts":   "text/plain; charset=utf-8",
	"tsx":  "text/plain; charset=utf-8",
	"jsx":  "text/plain; charset=utf-8",
	"go":   "text/plain; charset=utf-8",
	"py":   "text/plain; charset=utf-8",
	"c":    "text/plain; charset=utf-8",
	"cc":   "text/plain; charset=utf-8",
	"cpp":  "text/plain; charset=utf-8",
	"h":    "text/plain; charset=utf-8",
	"hpp":  "text/plain; charset=utf-8",
	"java": "text/plain; charset=utf-8",
	"rs":   "text/plain; charset=utf-8",
	"rb":   "text/plain; charset=utf-8",
	"php":  "text/plain; charset=utf-8",
	"sh":   "text/x-shellscript; charset=utf-8",
	"sql":  "text/plain; charset=utf-8",
	"yaml": "text/plain; charset=utf-8",
	"yml":  "text/plain; charset=utf-8",
	"toml": "text/plain; charset=utf-8",
	"ini":  "text/plain; charset=utf-8",
	"png":  "image/png",
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"gif":  "image/gif",
	"webp": "image/webp",
	"bmp":  "image/bmp",
	"svg":  "image/svg+xml",
	"mp3":  "audio/mpeg",
	"wav":  "audio/wav",
	"flac": "audio/flac",
	"ogg":  "audio/ogg",
	"m4a":  "audio/mp4",
	"mp4":  "video/mp4",
	"mov":  "video/quicktime",
	"webm": "video/webm",
	"mkv":  "video/x-matroska",
	"avi":  "video/x-msvideo",
}

func mimeFor(ext string, buf []byte) string {
	if value, ok := mimeByExtension[ext]; ok {
		return value
	}
	if value := mime.TypeByExtension("." + ext); value != "" {
		return value
	}
	return http.DetectContentType(buf)
}

func parseDimension(raw string) *int {
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || value > 10000 {
		return nil
	}
	rounded := int(math.Round(value))
	return &rounded
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
