// Package ids generates and validates document ids and asset filenames.
package ids

import (
	"crypto/rand"
	"regexp"
)

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

var (
	docIDPattern = regexp.MustCompile(`^[0-9a-z]{12}$`)
	assetPattern = regexp.MustCompile(`^[a-f0-9]{64}\.[a-z0-9]{1,10}$`)
)

// NewDocID returns a 12-character lowercase alphanumeric id.
func NewDocID() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, len(buf))
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out), nil
}

// IsDocID reports whether value has the expected shape.
func IsDocID(value string) bool { return docIDPattern.MatchString(value) }

// IsAssetFile reports whether value is a sha256-named uploaded file.
func IsAssetFile(value string) bool { return assetPattern.MatchString(value) }
