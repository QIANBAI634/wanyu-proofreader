package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// Increment when DPI, watermark or encoding changes. Assets stay private and
// derived; no URL exposes either the original book or the pre-split PDFs.
const pageImageVersion = "webp-2048-v1"

type pageImageMeta struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type pageImageDescriptor struct {
	pageImageMeta
	AssetID   string    `json:"assetId"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func imageSourceKey(file *core.Record) string {
	return pdfCacheKey(pdfSourceKey(file), pageImageVersion)
}
func imageDir(root string, file *core.Record) string {
	return filepath.Join(root, "images-"+imageSourceKey(file))
}

func lookupPageImage(root string, file *core.Record, n int, now time.Time) (string, pageImageMeta, bool) {
	dir := imageDir(root, file)
	ready, err := os.Stat(filepath.Join(dir, "ready"))
	if err != nil || !ready.ModTime().Add(pdfPagesTTL).After(now) {
		return "", pageImageMeta{}, false
	}
	raw, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("%d.json", n)))
	var meta pageImageMeta
	if err != nil || json.Unmarshal(raw, &meta) != nil || meta.Width < 1 || meta.Height < 1 || meta.Width > 2048 || meta.Height > 2048 {
		return "", meta, false
	}
	path := filepath.Join(dir, fmt.Sprintf("%d.webp", n))
	info, err := os.Stat(path)
	return path, meta, err == nil && info.Size() > 0
}

// Only called by the serial worker. Process arguments never go through a shell.
// Each renderer is bounded by a timeout and a 2048px longest edge.
func renderPageImage(parent context.Context, source, dir string, n int, stamp string) (pageImageMeta, error) {
	raw, err := os.ReadFile(source)
	if err != nil {
		return pageImageMeta{}, err
	}
	marked, err := watermarkTaskPDF(bytes.NewReader(raw), stamp)
	if err != nil {
		return pageImageMeta{}, err
	}
	pdf := filepath.Join(dir, "render.pdf")
	if err := os.WriteFile(pdf, marked, 0600); err != nil {
		return pageImageMeta{}, err
	}
	defer os.Remove(pdf)
	prefix := filepath.Join(dir, "render")
	png := prefix + ".png"
	defer os.Remove(png)
	if out, err := runImageCommand(parent, 30*time.Second, "pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-cropbox", "-scale-to", "2048", "-png", pdf, prefix); err != nil {
		return pageImageMeta{}, fmt.Errorf("page rasterization: %w: %.500s", err, out)
	}
	f, err := os.Open(png)
	if err != nil {
		return pageImageMeta{}, err
	}
	config, _, err := image.DecodeConfig(f)
	f.Close()
	if err != nil {
		return pageImageMeta{}, err
	}
	meta := pageImageMeta{config.Width, config.Height}
	if meta.Width < 1 || meta.Height < 1 || meta.Width > 2048 || meta.Height > 2048 {
		return meta, fmt.Errorf("invalid rendered dimensions")
	}
	if out, err := runImageCommand(parent, 30*time.Second, "cwebp", "-quiet", "-q", "90", png, "-o", filepath.Join(dir, fmt.Sprintf("%d.webp", n))); err != nil {
		return meta, fmt.Errorf("WebP encoding: %w: %.500s", err, out)
	}
	raw, _ = json.Marshal(meta)
	err = os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.json", n)), raw, 0600)
	return meta, err
}

func (s *importService) preparePDFImages(file *core.Record) error {
	ctx, cancel := context.WithTimeout(s.imageContext, 10*time.Minute)
	defer cancel()
	complete := file.GetInt("page_count") > 0
	for n := 1; n <= file.GetInt("page_count"); n++ {
		if _, _, ok := lookupPageImage(s.pdfCacheDir(), file, n, time.Now()); !ok {
			complete = false
			break
		}
	}
	if complete {
		return nil
	}
	// Missing optional tools is a degradation, never an import failure.
	for _, name := range []string{"pdftoppm", "cwebp"} {
		if _, err := exec.LookPath(name); err != nil {
			return err
		}
	}
	pdfCacheMu.Lock()
	source, err := s.preparePDFPages(file)
	pdfCacheMu.Unlock()
	if err != nil {
		return err
	}
	root := s.pdfCacheDir()
	// Outside the cache root: cleanup cannot delete work in progress.
	staging, err := os.MkdirTemp(s.app.DataDir(), "pdf-images-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	var size int64
	for n := 1; n <= file.GetInt("page_count"); n++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		stamp := fmt.Sprintf("Wanyu | %s p%d", pdfSourceKey(file)[:12], n)
		if _, err := renderPageImage(ctx, filepath.Join(source, fmt.Sprintf("%d.pdf", n)), staging, n, stamp); err != nil {
			return err
		}
		for _, ext := range []string{"webp", "json"} {
			info, err := os.Stat(filepath.Join(staging, fmt.Sprintf("%d.%s", n, ext)))
			if err != nil {
				return err
			}
			size += info.Size()
		}
		if size > pdfBookBudget {
			return errPDFPageBudget
		}
	}
	if err := os.WriteFile(filepath.Join(staging, "ready"), nil, 0600); err != nil {
		return err
	}
	pdfCacheMu.Lock()
	defer pdfCacheMu.Unlock()
	cleanupPDFCache(root, time.Now(), size)
	dest := imageDir(root, file)
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	return os.Rename(staging, dest)
}

// Nonblocking and deduplicated; never render or split on a preview request.
func (s *importService) schedulePDFImages(file *core.Record) {
	key := "pdf-images:" + file.Id
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.pending[key]; exists {
		return
	}
	// Back off failures (including absent render tools) for the retention window.
	failed := filepath.Join(s.pdfCacheDir(), "oversized-images-"+imageSourceKey(file))
	if info, err := os.Stat(failed); err == nil && info.ModTime().Add(pdfPagesTTL).After(time.Now()) {
		return
	}
	s.pending[key] = struct{}{}
	select {
	case s.imageQueue <- importWork{kind: "pdf-images", id: file.Id, requestID: "preview-" + file.Id, enqueuedAt: time.Now()}:
	default:
		delete(s.pending, key)
	}
}

func (s *importService) processPDFImages(work importWork) {
	file, err := s.app.FindRecordById("project_files", work.id)
	if err != nil || file.GetString("status") != "ready" {
		return
	}
	if err := s.preparePDFImages(file); err != nil {
		if s.imageContext.Err() != nil {
			return // Shutdown cancellation must not cause a 24-hour failure backoff.
		}
		pdfCacheMu.Lock()
		_ = os.MkdirAll(s.pdfCacheDir(), 0700)
		_ = os.WriteFile(filepath.Join(s.pdfCacheDir(), "oversized-images-"+imageSourceKey(file)), nil, 0600)
		pdfCacheMu.Unlock()
		logUpload("warn", "pdf_images_prepare_failed", map[string]any{"file_id": file.Id, "error": err.Error()})
	}
}

func imageWindowKey(file *core.Record, user string, n int, expiry time.Time) string {
	return pdfCacheKey(imageSourceKey(file), user, strconv.Itoa(n), expiry.Format(time.RFC3339))
}

func (s *importService) taskPageImage(c *core.RequestEvent) error {
	started := time.Now()
	file, start, end, err := s.resolveTaskPDF(c)
	if err != nil {
		return err
	}
	n, err := strconv.Atoi(c.Request.PathValue("number"))
	if err != nil || n < start || n > end {
		return apis.NewForbiddenError("只能查看当前任务允许的页面。", nil)
	}
	c.Response.Header().Set("Cache-Control", "private, no-store")
	c.Response.Header().Set("X-Content-Type-Options", "nosniff")
	expiry := time.Now().UTC().Truncate(pdfPreviewTTL).Add(pdfPreviewTTL)
	key := imageWindowKey(file, c.Auth.Id, n, expiry)
	if c.Request.PathValue("kind") == "asset" && (c.Request.URL.Query().Get("key") != key || c.Request.URL.Query().Get("expires") != strconv.FormatInt(expiry.Unix(), 10)) {
		return apis.NewForbiddenError("页面图片链接已过期，请重新加载。", nil)
	}
	pdfCacheMu.Lock()
	path, meta, ok := lookupPageImage(s.pdfCacheDir(), file, n, time.Now())
	if !ok {
		pdfCacheMu.Unlock()
		s.schedulePDFImages(file)
		return apis.NewNotFoundError("页面图片尚未就绪，请使用 PDF 预览。", nil)
	}
	touchPDFPages(filepath.Dir(path), time.Now())
	if c.Request.PathValue("kind") == "descriptor" {
		pdfCacheMu.Unlock()
		url := fmt.Sprintf("/api/fangji/pages/%s/images/%d/asset?key=%s&expires=%d", c.Request.PathValue("pageId"), n, key, expiry.Unix())
		return c.JSON(http.StatusOK, pageImageDescriptor{meta, pdfCacheKey(imageSourceKey(file), strconv.Itoa(n)), url, expiry})
	}
	if c.Request.PathValue("kind") != "asset" {
		pdfCacheMu.Unlock()
		return apis.NewNotFoundError("页面图片不存在。", nil)
	}
	data, err := os.ReadFile(path)
	pdfCacheMu.Unlock()
	if err != nil {
		return apis.NewNotFoundError("页面图片不可用，请使用 PDF 预览。", nil)
	}
	logPageImageAccess(c.Auth.Id, pdfCacheKey(imageSourceKey(file), strconv.Itoa(n)), pdfSourceKey(file), n, started)
	return c.Blob(http.StatusOK, "image/webp", data)
}

func runImageCommand(parent context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

var imageStagingName = regexp.MustCompile(`^pdf-images-[0-9]+$`)

// Startup only, before workers start: never age-delete active render directories.
func (s *importService) cleanupPDFImageStaging() {
	entries, err := os.ReadDir(s.app.DataDir())
	if err != nil {
		logUpload("warn", "pdf_images_cleanup_failed", map[string]any{"error": err.Error()})
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !imageStagingName.MatchString(entry.Name()) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.app.DataDir(), entry.Name())); err != nil {
			logUpload("warn", "pdf_images_cleanup_failed", map[string]any{"error": err.Error()})
		}
	}
}

// A dedicated worker bounds image concurrency at one without occupying imports.
func (s *importService) runPDFImageWorker(process func(importWork)) {
	for {
		select {
		case <-s.imageContext.Done():
			return
		case work := <-s.imageQueue:
			if s.imageContext.Err() != nil {
				return
			}
			s.executePDFImageWork(work, process)
		}
	}
}

func (s *importService) executePDFImageWork(work importWork, process func(importWork)) {
	started := time.Now()
	logUpload("info", "work_started", map[string]any{"kind": work.kind, "record_id": work.id, "request_id": work.requestID, "queue_wait_ms": started.Sub(work.enqueuedAt).Milliseconds()})
	defer s.finishWork(work)
	defer func() {
		if recovered := recover(); recovered != nil {
			logUpload("error", "worker_panic", map[string]any{"kind": work.kind, "record_id": work.id, "error": fmt.Sprint(recovered)})
		}
		logUpload("info", "work_finished", map[string]any{"kind": work.kind, "record_id": work.id, "duration_ms": time.Since(started).Milliseconds()})
	}()
	process(work)
}

func logPageImageAccess(userID, assetID, sourceKey string, n int, started time.Time) {
	logUpload("info", "pdf_preview", map[string]any{"user_id": userID, "asset_id": assetID, "source_key": sourceKey[:12], "page_range": strconv.Itoa(n), "cache": "image-hit", "total_ms": time.Since(started).Milliseconds()})
}
