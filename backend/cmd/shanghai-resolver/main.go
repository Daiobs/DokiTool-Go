package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/probe"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
)

var version = "development"

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		log.Fatal(err)
	}
}

func run(args []string) error {
	return runWithContext(context.Background(), args, os.Stdout)
}

func runWithContext(parentCtx context.Context, args []string, stdout io.Writer) error {
	if len(args) > 0 && args[0] == "version" {
		if len(args) != 1 {
			return errors.New("unexpected positional arguments")
		}
		if stdout == nil {
			stdout = os.Stdout
		}
		_, err := fmt.Fprintln(stdout, version)
		return err
	}
	flags := flag.NewFlagSet("shanghai-resolver", flag.ContinueOnError)
	listen := flags.String("listen", "127.0.0.1:9083", "explicit loopback address behind HTTPS ingress")
	cert := flags.String("tls-cert", "", "PEM certificate chain for native HTTPS")
	key := flags.String("tls-key", "", "PEM private key for native HTTPS")
	origin := flags.String("pull-origin", "", "Japan HTTPS origin for outbound Shanghai task leases")
	workers := flags.Int("workers", shresolver.DefaultPullWorkers, "concurrent pull worker loops (1-8)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if *workers < shresolver.MinPullWorkers || *workers > shresolver.MaxPullWorkers {
		return fmt.Errorf("workers must be between %d and %d", shresolver.MinPullWorkers, shresolver.MaxPullWorkers)
	}
	p := probe.New(fetch.New(), douyin.AllowedMediaURL).WithTimeout(shresolver.ProbeTimeout)
	var pull, serverOpt, workersOpt bool
	flags.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "pull-origin":
			pull = true
		case "workers":
			workersOpt = true
		case "listen", "tls-cert", "tls-key":
			serverOpt = true
		}
	})
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	if pull {
		if serverOpt {
			return errors.New("pull mode does not accept listener or TLS server options")
		}
		w, err := shresolver.NewPullWorkerWithDetail(*origin, os.Getenv("DOKITOOL_SHANGHAI_PULL_TOKEN"), fetch.New(), fetch.New(), p)
		if err != nil {
			return err
		}
		if _, err = w.WithWorkers(*workers); err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(parentCtx, os.Interrupt, syscall.SIGTERM)
		defer stop()
		log.Printf("shanghai-resolver: starting pull mode (version=%s, origin=%s, workers=%d)", version, *origin, *workers)
		if err = w.Run(ctx); errors.Is(err, context.Canceled) && ctx.Err() != nil {
			return nil
		}
		return err
	}
	if workersOpt {
		return errors.New("workers option requires -pull-origin")
	}
	if (*cert == "") != (*key == "") {
		return errors.New("tls-cert and tls-key must be set together")
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("invalid loopback listener")
	}
	h, err := shresolver.NewHandlerWithDetail(os.Getenv("DOKITOOL_SHANGHAI_TOKEN"), fetch.New(), p)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer ln.Close()
	ctx, stop := signal.NotifyContext(parentCtx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serveDirect(ctx, ln, h, *cert, *key)
}

var shutdownServer = (*http.Server).Shutdown

func directShutdownTimeout(s *http.Server) time.Duration {
	var shutdownTimeout time.Duration
	if s != nil {
		shutdownTimeout = s.WriteTimeout
	}
	if shutdownTimeout <= 0 {
		shutdownTimeout = shresolver.WorkTimeout + 2*time.Second
	}
	return shutdownTimeout
}

func serveDirect(ctx context.Context, ln net.Listener, h http.Handler, cert, key string) error {
	s := http.Server{Addr: ln.Addr().String(), Handler: h, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 4 * time.Second, WriteTimeout: shresolver.WorkTimeout + 2*time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8 << 10}
	done := make(chan error, 1)
	go func() {
		if cert != "" {
			done <- s.ServeTLS(ln, cert, key)
			return
		}
		done <- s.Serve(ln)
	}()
	log.Printf("shanghai-resolver: starting direct mode (version=%s, listen=%s, tls=%t)", version, ln.Addr().String(), cert != "")
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), directShutdownTimeout(&s))
		defer cancel()
		return shutdownServer(&s, shutdown)
	}
}
