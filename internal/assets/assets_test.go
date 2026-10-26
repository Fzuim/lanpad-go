package assets

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Fzuim/lanpad-go/internal/docstore"
)

func TestDetectImage(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		mime string
	}{
		{"png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00}, "image/png"},
		{"jpeg", []byte{0xff, 0xd8, 0xff, 0xe0}, "image/jpeg"},
		{"gif", []byte("GIF89a......"), "image/gif"},
		{"webp", append([]byte("RIFF....WEBP"), 0), "image/webp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info, ok := DetectImage(tc.data)
			if !ok {
				t.Fatalf("not detected")
			}
			if info.MIME != tc.mime {
				t.Fatalf("mime = %q, want %q", info.MIME, tc.mime)
			}
		})
	}
	if _, ok := DetectImage([]byte("plain text")); ok {
		t.Fatal("text detected as an image")
	}
}

func TestSaveDeduplicatesAndKeepsDimensions(t *testing.T) {
	root := t.TempDir()
	store, err := docstore.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	doc, err := store.CreateDoc("abcdefghijkl", "图片测试")
	if err != nil {
		t.Fatal(err)
	}
	assetsDir := filepath.Join(root, "assets")
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4}

	first, err := Save(store, assetsDir, doc.ID, "shot.png", png, "320.4", "200")
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if first.Width == nil || *first.Width != 320 {
		t.Fatalf("width = %v", first.Width)
	}
	if first.Height == nil || *first.Height != 200 {
		t.Fatalf("height = %v", first.Height)
	}
	full := filepath.Join(assetsDir, doc.ID, filepath.Base(first.URL))
	if _, err := os.Stat(full); err != nil {
		t.Fatalf("stored file: %v", err)
	}

	second, err := Save(store, assetsDir, doc.ID, "shot.png", png, "", "")
	if err != nil {
		t.Fatalf("second Save: %v", err)
	}
	if second.URL != first.URL {
		t.Fatalf("dedupe URL = %q, want %q", second.URL, first.URL)
	}
	if second.Width == nil || *second.Width != 320 || second.Height == nil || *second.Height != 200 {
		t.Fatalf("dedupe dimensions = %v x %v", second.Width, second.Height)
	}

	if _, err := Save(store, assetsDir, doc.ID, "bad.png", []byte("not-an-image"), "", ""); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unsupported error = %v", err)
	}
}

func TestSaveAttachment(t *testing.T) {
	root := t.TempDir()
	store, err := docstore.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	doc, err := store.CreateDoc("abcdefghijkl", "附件测试")
	if err != nil {
		t.Fatal(err)
	}
	assetsDir := filepath.Join(root, "assets")
	rarBytes := []byte("Rar!\x1a\x07\x00 this is a fake rar")

	saved, err := SaveAttachment(store, assetsDir, doc.ID, `C:\Users\队员\BaoGuaWindowsEvent.rar`, rarBytes)
	if err != nil {
		t.Fatalf("SaveAttachment: %v", err)
	}
	if saved.Kind != "file" || saved.Name != "BaoGuaWindowsEvent.rar" {
		t.Fatalf("saved = %+v", saved)
	}
	if saved.MIME != "application/vnd.rar" || saved.Ext != "rar" {
		t.Fatalf("mime/ext = %q/%q", saved.MIME, saved.Ext)
	}
	if saved.Size != int64(len(rarBytes)) {
		t.Fatalf("size = %d", saved.Size)
	}
	if !strings.HasSuffix(saved.URL, ".rar") {
		t.Fatalf("url = %q", saved.URL)
	}
	full := filepath.Join(assetsDir, doc.ID, filepath.Base(saved.URL))
	if _, err := os.Stat(full); err != nil {
		t.Fatalf("stored file: %v", err)
	}

	// Same bytes under a different display name dedupe to the same URL.
	again, err := SaveAttachment(store, assetsDir, doc.ID, "另一个名字.rar", rarBytes)
	if err != nil {
		t.Fatal(err)
	}
	if again.URL != saved.URL {
		t.Fatalf("dedupe URL = %q, want %q", again.URL, saved.URL)
	}
	if again.Name != "另一个名字.rar" {
		t.Fatalf("dedupe name = %q", again.Name)
	}

	if _, err := SaveAttachment(store, assetsDir, doc.ID, "empty.txt", nil); err == nil {
		t.Fatal("empty attachment was accepted")
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		`C:\Users\a\BaoGuaWindowsEvent.rar`: "BaoGuaWindowsEvent.rar",
		`../../etc/passwd`:                  "passwd",
		`  题目  附件.pdf  `:                    "题目  附件.pdf",
		`bad:name?.zip`:                     "bad_name_.zip",
		"":                                  "附件.bin",
	}
	for input, want := range cases {
		if got := sanitizeName(input, "附件.bin"); got != want {
			t.Fatalf("sanitizeName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseDimension(t *testing.T) {
	for raw, want := range map[string]int{"320": 320, "12.6": 13} {
		if got := parseDimension(raw); got == nil || *got != want {
			t.Fatalf("parseDimension(%q) = %v, want %d", raw, got, want)
		}
	}
	for _, raw := range []string{"", "0", "-1", "abc", "10001"} {
		if got := parseDimension(raw); got != nil {
			t.Fatalf("parseDimension(%q) = %v, want nil", raw, *got)
		}
	}
}
