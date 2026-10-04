package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfmodel "github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pocketbase/pocketbase/core"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const pdfPreviewTTL = 5 * time.Minute
const pdfPagesTTL = 24 * time.Hour
const pdfCacheBudget int64 = 1024 * 1024 * 1024
const pdfBookBudget int64 = 256 * 1024 * 1024

// Serialize CPU work, cold misses, cache publication and cleanup across requests.
var pdfCacheMu sync.Mutex
var errPDFPageBudget = errors.New("PDF page cache exceeds disk budget")

func (s *importService) pdfCacheDir() string {
	return filepath.Join(s.app.DataDir(), "pdf-preview-cache-v1")
}
func pdfCacheKey(parts ...string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%q", parts))))
}
func pdfSourceKey(file *core.Record) string {
	return pdfCacheKey(file.Id, file.GetString("file"), file.GetString("file_hash"))
}
func pdfConfig() *pdfmodel.Configuration {
	c := pdfmodel.NewDefaultConfiguration()
	c.ValidationMode = pdfmodel.ValidationRelaxed
	return c
}

// Must hold pdfCacheMu. Expire artifacts, then evict oldest entries for new writes.
func cleanupPDFCache(root string, now time.Time, reserve int64) {
	entries, _ := os.ReadDir(root)
	type artifact struct {
		path     string
		modified time.Time
		size     int64
	}
	var live []artifact
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		p := filepath.Join(root, e.Name())
		ttl := pdfPreviewTTL
		if e.IsDir() || strings.HasPrefix(e.Name(), "oversized-") {
			ttl = pdfPagesTTL
		}
		if !info.ModTime().Add(ttl).After(now) {
			_ = os.RemoveAll(p)
			continue
		}
		var size int64
		_ = filepath.WalkDir(p, func(_ string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				if i, e := d.Info(); e == nil {
					size += i.Size()
				}
			}
			return nil
		})
		live = append(live, artifact{p, info.ModTime(), size})
		total += size
	}
	sort.Slice(live, func(i, j int) bool { return live[i].modified.Before(live[j].modified) })
	for _, a := range live {
		if total+reserve <= pdfCacheBudget {
			break
		}
		if os.RemoveAll(a.path) == nil {
			total -= a.size
		}
	}
}

// previewStages records where one preview request spent its time, so the
// numbers the issue asks for can be read off a single log line. A nil receiver
// means "not measuring": the rendering helpers stay callable from tests that
// only care about the bytes they return.
type previewStages struct {
	Lookup    time.Duration
	Open      time.Duration
	Extract   time.Duration
	Merge     time.Duration
	Watermark time.Duration
}

// Lookup and Open are kept apart on purpose: probing the cache is a stat on a
// warm filesystem, opening the source is I/O on a file that may not be cached.
// Adding them into one number made the reading ambiguous.
func (p *previewStages) markLookup(since time.Time) {
	if p != nil {
		p.Lookup += time.Since(since)
	}
}

func (p *previewStages) markOpen(since time.Time) {
	if p != nil {
		p.Open += time.Since(since)
	}
}

func (p *previewStages) markExtract(since time.Time) {
	if p != nil {
		p.Extract += time.Since(since)
	}
}

func (p *previewStages) markMerge(since time.Time) {
	if p != nil {
		p.Merge += time.Since(since)
	}
}

func (p *previewStages) markWatermark(since time.Time) {
	if p != nil {
		p.Watermark += time.Since(since)
	}
}

// lookupPDFPages answers "is the pre-split cache usable right now" without ever
// building anything. Requests use this and degrade to trimming the window;
// only the import worker builds. Splitting a whole book inside a request put
// multi-second work on the first screen of every cold or expired book, behind a
// process-wide mutex that serialised everyone else.
func lookupPDFPages(root, sourceKey string, now time.Time) (string, bool) {
	dir := filepath.Join(root, "pages-"+sourceKey)
	if info, err := os.Stat(filepath.Join(dir, "ready")); err == nil && info.ModTime().Add(pdfPagesTTL).After(now) {
		return dir, true
	}
	return "", false
}

// touchPDFPages restarts the page cache's retention window. Without it the 24h
// TTL is counted from the split, so a book in daily use would lose its cache on
// a timer and pay the degraded path forever after. Touching on use makes the
// window follow the material: idle books still expire, busy ones do not.
//
// ready is the file the request-path gate reads, so it is the timestamp the
// window has to move; the directory mtime only drives cleanupPDFCache's expiry
// and LRU ordering.
func touchPDFPages(dir string, now time.Time) {
	_ = os.Chtimes(filepath.Join(dir, "ready"), now, now)
	_ = os.Chtimes(dir, now, now)
}

func (s *importService) preparePDFPages(file *core.Record) (string, error) {
	root := s.pdfCacheDir()
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	// Remember expansion failures per immutable source: otherwise every new task
	// would repeat the same expensive whole-book split before falling back.
	oversized := filepath.Join(root, "oversized-"+pdfSourceKey(file))
	if info, err := os.Stat(oversized); err == nil && info.ModTime().Add(pdfPagesTTL).After(time.Now()) {
		return "", errPDFPageBudget
	}
	dir, cached := lookupPDFPages(root, pdfSourceKey(file), time.Now())
	if cached {
		return dir, nil
	}
	dir = filepath.Join(root, "pages-"+pdfSourceKey(file))
	cleanupPDFCache(root, time.Now(), pdfBookBudget)
	_ = os.RemoveAll(dir)
	staging, err := os.MkdirTemp(root, "building-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	reader, closeFile, err := s.openRecordFile(file, "file")
	if err != nil {
		return "", err
	}
	defer closeFile()
	if err := splitPDFPages(reader, staging, pdfBookBudget); err != nil {
		if errors.Is(err, errPDFPageBudget) {
			_ = os.WriteFile(oversized, nil, 0600)
		}
		return "", err
	}
	if err := os.WriteFile(filepath.Join(staging, "ready"), nil, 0600); err != nil {
		return "", err
	}
	if err := os.Rename(staging, dir); err != nil {
		return "", err
	}
	return dir, nil
}

// Parse the book once, extracting one page at a time to bound memory and disk expansion.
func splitPDFPages(reader io.ReadSeeker, dir string, budget int64) error {
	pdfapi.DisableConfigDir()
	ctx, err := pdfapi.ReadValidateAndOptimize(context.Background(), reader, pdfConfig(), nil)
	if err != nil {
		return err
	}
	for n := 1; n <= ctx.PageCount; n++ {
		page, err := pdfapi.ExtractPage(context.Background(), ctx, n)
		if err != nil {
			return err
		}
		f, err := os.OpenFile(filepath.Join(dir, fmt.Sprintf("%d.pdf", n)), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		written, copyErr := io.Copy(f, io.LimitReader(page, budget+1))
		closeErr := f.Close()
		budget -= written
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if budget < 0 {
			return errPDFPageBudget
		}
	}
	return nil
}

// cachedTaskPDF renders the couple of pages a task shows. It never does
// whole-book work: a miss on the pre-split cache falls straight through to
// trimming this window out of the source, which is what
// docs/task-pdf-cache.md already specifies ("退回按需两页生成"). The import
// worker is the only thing that splits whole books, and it does so off the
// request path.
func (s *importService) cachedTaskPDF(file *core.Record, descriptor pdfPreviewDescriptor, userID string) ([]byte, error) {
	pdfCacheMu.Lock()
	defer pdfCacheMu.Unlock()
	now := time.Now()
	start, end := descriptor.Start, descriptor.End
	sourceKey := pdfSourceKey(file)
	pageRange := fmt.Sprintf("%d-%d", start, end)
	root := s.pdfCacheDir()
	outputPath := filepath.Join(root, "watermark-"+descriptor.Key+".pdf")
	// The handler checks live permissions and leases BEFORE every cache lookup.
	if info, err := os.Stat(outputPath); err == nil && info.ModTime().Add(pdfPreviewTTL).After(now) {
		if data, err := os.ReadFile(outputPath); err == nil {
			logPDFPreview("watermark-hit", sourceKey, pageRange, nil, time.Since(now))
			return data, nil
		}
	}
	cleanupPDFCache(root, now, pdfBookBudget)
	stamp := fmt.Sprintf("Wanyu | %s | %s p%d-%d | %s UTC", userID, sourceKey[:12], start, end, descriptor.ExpiresAt.Add(-pdfPreviewTTL).UTC().Format("2006-01-02 15:04:05"))

	stages := &previewStages{}
	lookupStart := time.Now()
	dir, cached := lookupPDFPages(root, sourceKey, now)
	stages.markLookup(lookupStart)

	var output []byte
	var err error
	// Decided here, not after the fallback: the fallback reassigns err and any
	// error returns before the log, so a merge that failed and then recovered
	// would otherwise be recorded as a clean cache hit — the one verdict that
	// would make this instrumentation lie about what happened.
	cacheState := "miss-degraded"
	if cached {
		cacheState = "pages-unreadable-degraded"
		output, err = mergeCachedPDFPages(dir, start, end, stamp, stages)
		if err == nil {
			// Kept warm by use, so the 24h window follows the material rather
			// than a timer set when the split happened.
			touchPDFPages(dir, now)
			cacheState = "pages-hit"
		}
	}
	// A miss is not an error: the documented fallback is generating just these
	// two pages from the source. It must stay off the whole-book path even when
	// a stale page directory is present but unreadable.
	if !cached || err != nil {
		openStart := time.Now()
		reader, closeFile, e := s.openRecordFile(file, "file")
		stages.markOpen(openStart)
		if e != nil {
			return nil, e
		}
		defer closeFile()
		output, err = buildTaskPDF(reader, start, end, stamp, stages)
	}
	if err != nil {
		return nil, err
	}
	if int64(len(output)) <= pdfBookBudget {
		_ = os.MkdirAll(root, 0700)
		cleanupPDFCache(root, time.Now(), int64(len(output)))
		_ = os.WriteFile(outputPath, output, 0600)
	}
	logPDFPreview(cacheState, sourceKey, pageRange, stages, time.Since(now))
	return output, nil
}

// logPDFPreview emits the per-request per-stage costs. Kept next to the request
// path because the numbers are only meaningful with the cache verdict: a
// degraded request and a cache hit are different code paths, and reading
// extract time off a hit would always show zero.
func logPDFPreview(cache, sourceKey, pageRange string, stages *previewStages, total time.Duration) {
	fields := map[string]any{
		"source_key": sourceKey[:12],
		"page_range": pageRange,
		"cache":      cache,
		"total_ms":   total.Milliseconds(),
	}
	if stages != nil {
		fields["lookup_ms"] = stages.Lookup.Milliseconds()
		fields["open_ms"] = stages.Open.Milliseconds()
		fields["extract_ms"] = stages.Extract.Milliseconds()
		fields["merge_ms"] = stages.Merge.Milliseconds()
		fields["watermark_ms"] = stages.Watermark.Milliseconds()
	}
	logUpload("info", "pdf_preview", fields)
}

func mergeCachedPDFPages(dir string, start, end int, stamp string, stages *previewStages) ([]byte, error) {
	openStart := time.Now()
	var readers []io.ReadSeeker
	for n := start; n <= end; n++ {
		f, err := os.Open(filepath.Join(dir, fmt.Sprintf("%d.pdf", n)))
		if err != nil {
			return nil, err
		}
		defer f.Close()
		readers = append(readers, f)
	}
	stages.markOpen(openStart)
	var excerpt bytes.Buffer
	mergeStart := time.Now()
	err := pdfapi.MergeRaw(context.Background(), readers, &excerpt, false, pdfConfig())
	stages.markMerge(mergeStart)
	if err != nil {
		return nil, err
	}
	watermarkStart := time.Now()
	output, err := watermarkTaskPDF(bytes.NewReader(excerpt.Bytes()), stamp)
	stages.markWatermark(watermarkStart)
	return output, err
}
