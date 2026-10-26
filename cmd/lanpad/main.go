// Command lanpad is the Go implementation of the LAN Pad server.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Fzuim/lanpad-go/internal/collab"
	"github.com/Fzuim/lanpad-go/internal/config"
	"github.com/Fzuim/lanpad-go/internal/docstore"
	"github.com/Fzuim/lanpad-go/internal/network"
	"github.com/Fzuim/lanpad-go/internal/openbrowser"
	"github.com/Fzuim/lanpad-go/internal/web"
)

const version = "0.1.0-go"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "\n  %v\n", err)
		pauseIfInteractive()
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	store, err := docstore.Open(cfg.DBFile)
	if err != nil {
		return err
	}

	manager := collab.New(store)
	app := web.New(cfg, store, manager)

	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.Port)))
	if err != nil {
		_ = store.Close()
		if isAddrInUse(err) {
			return fmt.Errorf("端口 %d 已被占用。可能是 LAN Pad 已经在运行，或改用 PORT=xxxx 启动", cfg.Port)
		}
		return err
	}

	httpServer := &http.Server{
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	printBanner(cfg)

	serveErr := make(chan error, 1)
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	if shouldOpenBrowser() {
		openbrowser.Open(fmt.Sprintf("http://localhost:%d", cfg.Port))
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)

	exitCode := 0
	select {
	case sig := <-signals:
		fmt.Printf("\n[%s] 正在保存并退出...\n", sigName(sig))
	case err := <-serveErr:
		fmt.Fprintf(os.Stderr, "\n  服务异常退出: %v\n", err)
		exitCode = 1
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_ = httpServer.Shutdown(shutdownCtx)
	_ = manager.Close(shutdownCtx)
	store.FlushMetaAll()
	if err := store.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "  关闭数据库失败: %v\n", err)
	}
	if exitCode != 0 {
		os.Exit(exitCode)
	}
	return nil
}

func printBanner(cfg *config.Config) {
	info := network.Discover(cfg.Port, cfg.PublicBaseURL)
	addresses := make([]string, 0, len(info.Addresses))
	for _, item := range info.Addresses {
		addresses = append(addresses, fmt.Sprintf("%s: %s", item.Iface, item.URL))
	}

	fmt.Println()
	fmt.Printf("  LAN Pad · 队内题目协作（Go %s）\n", version)
	fmt.Printf("  本机访问:   http://localhost:%d\n", cfg.Port)
	fmt.Printf("  局域网访问: %s\n", info.Primary)
	if len(addresses) > 1 {
		fmt.Println("  检测到多个网卡:")
		for _, line := range addresses {
			fmt.Printf("    - %s\n", line)
		}
	}
	fmt.Println()
	fmt.Printf("  主机密钥: %s\n", cfg.HostKey)
	fmt.Println("  （删除文档等主机操作才需要，队友不用）")
	fmt.Printf("  数据目录: %s\n", cfg.DataDir)
	fmt.Println()
}

func shouldOpenBrowser() bool {
	return os.Getenv("LANPAD_OPEN") != "0"
}

func isAddrInUse(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		var sysErr *os.SyscallError
		if errors.As(opErr.Err, &sysErr) {
			return errors.Is(sysErr.Err, syscall.EADDRINUSE)
		}
	}
	return errors.Is(err, syscall.EADDRINUSE)
}

func sigName(sig os.Signal) string {
	if sig == os.Interrupt {
		return "SIGINT"
	}
	return sig.String()
}

func pauseIfInteractive() {
	info, err := os.Stdin.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return
	}
	fmt.Print("  按回车键退出...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
