// Package openbrowser launches the system browser without blocking.
package openbrowser

import (
	"os/exec"
	"runtime"
)

// Open opens url in the default browser. Failure is intentionally ignored:
// the server keeps running even when no browser can be launched.
func Open(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return
	}
	_ = cmd.Process.Release()
}
