package provide

import (
	"bytes"
	"context"
	"crypto/tls"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"text/template"
	"time"

	"filippo.io/intermediates"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/samber/lo"
	"github.com/xmdhs/clash2sfa/handle"
	"github.com/xmdhs/clash2sfa/service"
)

//go:embed static
var static embed.FS

//go:embed frontend.html
var FrontendByte []byte

// html 是首页模板的数据：模块路径与构建版本，用于页面标识与静态资源缓存失效。
type html struct {
	Path string
	Hash string
}

var info html

func init() {
	info.Hash = os.Getenv("VERCEL_GIT_COMMIT_SHA")
	if bi, ok := debug.ReadBuildInfo(); ok {
		info.Path = bi.Main.Path
		if rev := vcsRevision(bi.Settings); rev != "" {
			info.Hash = rev
		}
	}
}

func vcsRevision(settings []debug.BuildSetting) string {
	for _, v := range settings {
		if v.Key == "vcs.revision" {
			return v.Value
		}
	}
	return ""
}

func NewApp(h slog.Handler) http.Handler {
	return newMux(newClient(), newSlog(h))
}

// newClient 用于抓取订阅。自行校验证书链，以便补全服务器未下发的中间证书。
func newClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection:   intermediates.VerifyConnection,
	}
	return &http.Client{
		Transport: tr,
		Timeout:   60 * time.Second,
	}
}

func newSlog(h slog.Handler) *slog.Logger {
	return slog.New(&reqIDHandler{Handler: h})
}

func newMux(c *http.Client, l *slog.Logger) *chi.Mux {
	staticFS := lo.Must(fs.Sub(static, "static"))
	convert := service.NewConvert(c, l)
	subH := handle.NewHandle(convert, l, staticFS)

	mux := chi.NewMux()
	mux.Use(middleware.RequestID)
	mux.Use(middleware.RealIP)
	mux.Use(newStructuredLogger(l))

	mux.Get("/sub", subH.Sub)
	mux.Post("/convert", subH.ConvertContent)
	mux.With(Cache).Mount("/config", http.StripPrefix("/config", http.FileServerFS(staticFS)))
	mux.With(Cache).Mount("/static", http.StripPrefix("/static", http.FileServerFS(staticFS)))
	mux.With(Cache).HandleFunc("/", handle.Frontend(renderIndex()))
	return mux
}

// renderIndex 在启动时渲染一次首页；模板用 [[ ]] 作分隔符，避免与页面内容中的花括号冲突。
func renderIndex() []byte {
	tpl := lo.Must(template.New("index").Delims("[[", "]]").Parse(string(FrontendByte)))
	var buf bytes.Buffer
	lo.Must0(tpl.Execute(&buf, info))
	return buf.Bytes()
}

func newStructuredLogger(logger *slog.Logger) func(next http.Handler) http.Handler {
	return middleware.RequestLogger(&StructuredLogger{Logger: logger})
}

// StructuredLogger 把 chi 的请求日志接到 slog。
type StructuredLogger struct {
	Logger *slog.Logger
}

func (l *StructuredLogger) NewLogEntry(r *http.Request) middleware.LogEntry {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	ctx := r.Context()
	l.Logger.LogAttrs(ctx, slog.LevelDebug, "request started",
		slog.String("http_method", r.Method),
		slog.String("remote_addr", r.RemoteAddr),
		slog.String("user_agent", r.UserAgent()),
		slog.String("uri", fmt.Sprintf("%s://%s%s", scheme, r.Host, r.RequestURI)),
	)
	return &StructuredLoggerEntry{Logger: l.Logger, ctx: ctx}
}

type StructuredLoggerEntry struct {
	Logger *slog.Logger
	ctx    context.Context
}

func (l *StructuredLoggerEntry) Write(status, bytes int, header http.Header, elapsed time.Duration, extra any) {
	l.Logger.LogAttrs(l.ctx, slog.LevelDebug, "request complete",
		slog.Int("resp_status", status),
		slog.Int("resp_byte_length", bytes),
		slog.Float64("resp_elapsed_ms", float64(elapsed.Nanoseconds())/1000000.0),
	)
}

func (l *StructuredLoggerEntry) Panic(v any, stack []byte) {
	l.Logger.LogAttrs(l.ctx, slog.LevelDebug, "",
		slog.String("stack", string(stack)),
		slog.String("panic", fmt.Sprintf("%+v", v)),
	)
}

// reqIDHandler 给每条日志附上 chi 生成的请求 ID。
type reqIDHandler struct {
	slog.Handler
}

func (h *reqIDHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := middleware.GetReqID(ctx); id != "" {
		r.AddAttrs(slog.String("req_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

// Cache 给静态资源加 12 小时的缓存头。
func Cache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=43200, s-maxage=43200")
		h.ServeHTTP(w, r)
	})
}
