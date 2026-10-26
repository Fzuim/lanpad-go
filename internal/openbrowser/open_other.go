//go:build !windows

package openbrowser

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
