package ytengine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultConcurrency is the default shared yt-dlp subprocess limit.
	DefaultConcurrency = 2
	// MaxConcurrency caps DOKITOOL_YTDLP_CONCURRENCY on a 6C / 13G host.
	MaxConcurrency        = 24
	defaultMaxConcurrency = DefaultConcurrency
	maxAllowedConcurrency = MaxConcurrency
)

// Extract invokes yt-dlp -J in an isolated temporary directory and parses the subset Info.
func (e *Engine) Extract(ctx context.Context, rawURL string) (*Info, error) {
	if e == nil || !e.enabled {
		return nil, &Error{
			Code:      CodeServiceNotConfigured,
			Message:   "当前平台解析服务暂不可用",
			Retryable: false,
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, classifyContextErr(err)
	}
	if err := validateInputURL(rawURL, e.allowedURL); err != nil {
		return nil, err
	}

	if e.subSem != nil {
		var releaseSubOnce sync.Once
		releaseSub := func() {
			releaseSubOnce.Do(func() {
				<-e.subSem
			})
		}
		select {
		case e.subSem <- struct{}{}:
			if err := ctx.Err(); err != nil {
				releaseSub()
				return nil, classifyContextErr(err)
			}
			defer releaseSub()
		case <-ctx.Done():
			return nil, classifyContextErr(ctx.Err())
		}
	}

	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			<-e.sem
		})
	}
	chIdx := channelIndex(ChannelFromContext(ctx))
	select {
	case e.sem <- struct{}{}:
		if err := ctx.Err(); err != nil {
			release()
			return nil, classifyContextErr(err)
		}
		if e.slotStats != nil {
			e.slotStats.recordUncontendedAcquire(chIdx)
		}
		defer release()
	default:
		waitStart := time.Now()
		if e.slotStats != nil {
			e.slotStats.incWaiting(chIdx)
		}
		select {
		case e.sem <- struct{}{}:
			waitDur := time.Since(waitStart)
			if e.slotStats != nil {
				e.slotStats.decWaiting(chIdx)
			}
			if err := ctx.Err(); err != nil {
				release()
				if e.slotStats != nil {
					e.slotStats.recordContendedWait(chIdx, waitDur, true)
				}
				return nil, classifyContextErr(err)
			}
			if e.slotStats != nil {
				e.slotStats.recordContendedWait(chIdx, waitDur, false)
			}
			defer release()
		case <-ctx.Done():
			waitDur := time.Since(waitStart)
			if e.slotStats != nil {
				e.slotStats.decWaiting(chIdx)
				e.slotStats.recordContendedWait(chIdx, waitDur, true)
			}
			return nil, classifyContextErr(ctx.Err())
		}
	}

	callCtx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	if e.allowedOutboundHost != nil || e.resolver != nil {
		if err := e.verifyPublicTargetHost(callCtx, rawURL); err != nil {
			return nil, err
		}
		if e.proxyURL != "" {
			return nil, &Error{
				Code:      CodeUpstreamBlocked,
				Message:   "受控出站安全策略不允许使用未受控外部代理",
				Retryable: false,
			}
		}
	}

	effectiveProxy := e.proxyURL
	if e.allowedOutboundHost != nil || e.resolver != nil {
		gateURL, closeGate, err := e.startOutboundGate(callCtx)
		if err != nil {
			return nil, &Error{
				Code:      CodeUpstreamUnavailable,
				Message:   "解析安全网关初始化失败",
				Retryable: true,
				Cause:     err,
			}
		}
		defer closeGate()
		effectiveProxy = gateURL
	}

	tempDir, err := os.MkdirTemp("", "dokitool-ytdlp-*")
	if err != nil {
		return nil, &Error{
			Code:      CodeUpstreamUnavailable,
			Message:   "解析环境初始化失败",
			Retryable: true,
			Cause:     err,
		}
	}
	defer os.RemoveAll(tempDir)

	for _, sub := range []string{"cache", "config", "data", "tmp"} {
		if err := os.MkdirAll(filepath.Join(tempDir, sub), 0o700); err != nil {
			return nil, &Error{
				Code:      CodeUpstreamUnavailable,
				Message:   "解析环境初始化失败",
				Retryable: true,
				Cause:     err,
			}
		}
	}

	info, _, extractErr := e.runSubprocess(callCtx, rawURL, effectiveProxy, tempDir)
	return info, extractErr
}

func (e *Engine) runSubprocess(callCtx context.Context, rawURL, effectiveProxy, tempDir string) (*Info, string, error) {
	args := e.commandArgsWithProxy(rawURL, effectiveProxy)
	var cmd *exec.Cmd
	if e.pythonPath != "" {
		pyArgs := make([]string, 0, len(args)+1)
		pyArgs = append(pyArgs, e.binaryPath)
		pyArgs = append(pyArgs, args...)
		cmd = exec.CommandContext(callCtx, e.pythonPath, pyArgs...)
	} else {
		cmd = exec.CommandContext(callCtx, e.binaryPath, args...)
	}
	cmd.Dir = tempDir
	cmd.Stdin = nil
	cmd.Env = buildIsolatedEnv(tempDir, e.envPath)
	configureProcessGroup(cmd)

	stdout := &limitedBuffer{max: e.maxStdoutBytes}
	stderr := &limitedBuffer{max: defaultMaxStderrBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	runErr := cmd.Run()
	stderrText := stderr.String()
	if callCtx.Err() != nil {
		return nil, stderrText, classifyContextErr(callCtx.Err())
	}
	if stdout.overflow {
		return nil, stderrText, &Error{
			Code:      CodeUpstreamInvalidResponse,
			Message:   "上游返回的元数据超出大小限制",
			Retryable: false,
		}
	}
	if runErr != nil {
		return nil, stderrText, classifyStderr(stderrText, runErr)
	}

	rawJSON := bytes.TrimSpace(stdout.Bytes())
	if len(rawJSON) == 0 {
		return nil, stderrText, &Error{
			Code:      CodeUpstreamInvalidResponse,
			Message:   "上游未返回有效的元数据",
			Retryable: false,
		}
	}
	var info Info
	if err := json.Unmarshal(rawJSON, &info); err != nil {
		return nil, stderrText, &Error{
			Code:      CodeUpstreamInvalidResponse,
			Message:   "上游返回的元数据格式异常",
			Retryable: false,
			Cause:     err,
		}
	}
	if info.ID == "" && len(info.Formats) == 0 && len(info.Entries) == 0 {
		return nil, stderrText, &Error{
			Code:      CodeContentUnavailable,
			Message:   "未找到可用的作品内容",
			Retryable: false,
		}
	}
	return &info, stderrText, nil
}

func buildIsolatedEnv(tempDir, envPath string) []string {
	tmpSub := filepath.Join(tempDir, "tmp")
	env := []string{
		"HOME=" + tempDir,
		"XDG_CACHE_HOME=" + filepath.Join(tempDir, "cache"),
		"XDG_CONFIG_HOME=" + filepath.Join(tempDir, "config"),
		"XDG_DATA_HOME=" + filepath.Join(tempDir, "data"),
		"TMPDIR=" + tmpSub,
		"TEMP=" + tmpSub,
		"TMP=" + tmpSub,
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PYTHONIOENCODING=utf-8",
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONNOUSERSITE=1",
		"NO_COLOR=1",
		"NO_PROXY=",
		"no_proxy=",
		"HTTP_PROXY=",
		"HTTPS_PROXY=",
		"ALL_PROXY=",
		"http_proxy=",
		"https_proxy=",
		"all_proxy=",
	}
	if envPath != "" {
		env = append(env, "PATH="+envPath)
	} else {
		env = append(env, "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
	}
	if sysRoot := os.Getenv("SYSTEMROOT"); sysRoot != "" {
		env = append(env, "SYSTEMROOT="+sysRoot)
	}
	return env
}

func classifyContextErr(err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{
			Code:      CodeUpstreamTimeout,
			Message:   "上游解析超时，请稍后重试",
			Retryable: true,
			Cause:     err,
		}
	}
	return &Error{
		Code:      CodeUpstreamTimeout,
		Message:   "解析请求已取消或超时",
		Retryable: true,
		Cause:     err,
	}
}

func classifyStderr(stderrText string, runErr error) *Error {
	lower := strings.ToLower(stderrText)
	switch {
	case strings.Contains(lower, "upstream blocked by outbound security policy") ||
		strings.Contains(lower, "tunnel connection failed: 403"):
		return &Error{
			Code:      CodeUpstreamBlocked,
			Message:   "目标地址或重定向跳点超出安全出站边界，已拒绝访问",
			Retryable: false,
			Cause:     runErr,
		}
	case strings.Contains(lower, "unsupported url") ||
		strings.Contains(lower, "no suitable extractor"):
		return &Error{
			Code:           CodeContentUnavailable,
			Message:        "未找到可用的媒体，或该内容已不可访问",
			Retryable:      false,
			UnsupportedURL: true,
			Cause:          runErr,
		}
	case strings.Contains(lower, "429") ||
		strings.Contains(lower, "too many requests") ||
		strings.Contains(lower, "rate limit"):
		return &Error{
			Code:      CodeRateLimited,
			Message:   "上游访问频率受限，请稍后重试",
			Retryable: true,
			Cause:     runErr,
		}
	case strings.Contains(lower, "timed out") ||
		strings.Contains(lower, "timeout"):
		return &Error{
			Code:      CodeUpstreamTimeout,
			Message:   "上游连接超时，请稍后重试",
			Retryable: true,
			Cause:     runErr,
		}
	case strings.Contains(lower, "protected tweet") ||
		strings.Contains(lower, "nsfw tweet") ||
		strings.Contains(lower, "age-restricted") ||
		strings.Contains(lower, "login required") ||
		strings.Contains(lower, "must log in") ||
		strings.Contains(lower, "log in to continue") ||
		strings.Contains(lower, "registered users") ||
		strings.Contains(lower, "provide account credentials") ||
		strings.Contains(lower, "sign in") ||
		(strings.Contains(lower, "[facebook") && strings.Contains(lower, "cannot parse data")) ||
		strings.Contains(lower, "facebook said:") ||
		strings.Contains(lower, "http error 401") ||
		strings.Contains(lower, "http error 403"):
		return &Error{
			Code:      CodeUpstreamBlocked,
			Message:   "该内容受访问限制（如私密账号或年龄限制），无法无凭据解析",
			Retryable: false,
			Cause:     runErr,
		}
	case strings.Contains(lower, "no video could be found") ||
		strings.Contains(lower, "there's nothing here") ||
		strings.Contains(lower, "status is not available") ||
		strings.Contains(lower, "tweet not found") ||
		strings.Contains(lower, "does not exist") ||
		strings.Contains(lower, "http error 404") ||
		strings.Contains(lower, "unavailable"):
		return &Error{
			Code:      CodeContentUnavailable,
			Message:   "未找到可用的媒体，或该内容已不可访问",
			Retryable: false,
			Cause:     runErr,
		}
	default:
		return &Error{
			Code:      CodeUpstreamUnavailable,
			Message:   "当前平台解析服务暂不可用，请稍后重试",
			Retryable: true,
			Cause:     runErr,
		}
	}
}

type limitedBuffer struct {
	buf      bytes.Buffer
	max      int64
	overflow bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.overflow {
		return len(p), nil
	}
	remaining := b.max - int64(b.buf.Len())
	if int64(len(p)) > remaining {
		if remaining > 0 {
			_, _ = b.buf.Write(p[:remaining])
		}
		b.overflow = true
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *limitedBuffer) Bytes() []byte {
	return b.buf.Bytes()
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}
