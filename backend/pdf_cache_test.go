package main

import (
	"bytes"
	"errors"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeSourcePDF places bytes where openRecordFile looks for them.
func writeSourcePDF(t *testing.T, app *pocketbase.PocketBase, collectionID, recordID string, data []byte) {
	t.Helper()
	dir := filepath.Join(app.DataDir(), "storage", collectionID, recordID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "source.pdf"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func sourcePDFRecord(t *testing.T, app *pocketbase.PocketBase) (*core.Record, string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("project_files")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Id = "previewsource001"
	record.Set("file", "source.pdf")
	record.Set("file_hash", "version-one")
	record.Set("page_count", 3)
	return record, collection.Id
}

// A request that finds no pre-split pages must trim its own window and nothing
// more. This split used to happen here, on the first screen of every cold or
// expired book, behind the process-wide mutex that serialises every preview.
func TestCachedTaskPDFDegradesWithoutSplittingTheBook(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	record, collectionID := sourcePDFRecord(t, app)
	writeSourcePDF(t, app, collectionID, record.Id, renderingTestPDF())

	descriptor := describePDF(record, 1, 2, "alice", time.Now())
	output, err := s.cachedTaskPDF(record, descriptor, "proofreader0001")
	if err != nil {
		t.Fatal(err)
	}
	count, err := pdfapi.PageCount(bytes.NewReader(output), nil)
	if err != nil || count != 2 {
		t.Fatalf("degraded preview: count=%d err=%v", count, err)
	}
	// The page cache stays absent: building it is the import worker's job.
	if _, ok := lookupPDFPages(s.pdfCacheDir(), pdfSourceKey(record), time.Now()); ok {
		t.Fatal("request path reported a page cache it never built")
	}
	entries, _ := os.ReadDir(s.pdfCacheDir())
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "pages-") {
			t.Fatalf("request path split the whole book: %s", entry.Name())
		}
	}
}

// A cache hit must not age out from under a book that is in daily use. Without
// the touch, retention is counted from the split, so a busy book loses its
// cache on a timer and pays the degraded path from then on.
func TestCachedTaskPDFKeepsAHitWarm(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	record, collectionID := sourcePDFRecord(t, app)
	writeSourcePDF(t, app, collectionID, record.Id, renderingTestPDF())

	root := s.pdfCacheDir()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "pages-"+pdfSourceKey(record))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := splitPDFPages(bytes.NewReader(renderingTestPDF()), dir, pdfBookBudget); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ready"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	// Just inside the window, so the hit only succeeds if it is also refreshed.
	// Both timestamps have to age: lookupPDFPages gates on ready, cleanupPDFCache
	// on the directory. Aging only the directory leaves this test passing even
	// with no touch at all, which is how it first shipped.
	aged := time.Now().Add(-pdfPagesTTL + time.Minute)
	if err := os.Chtimes(filepath.Join(dir, "ready"), aged, aged); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(dir, aged, aged); err != nil {
		t.Fatal(err)
	}

	descriptor := describePDF(record, 1, 2, "alice", time.Now())
	if _, err := s.cachedTaskPDF(record, descriptor, "proofreader0001"); err != nil {
		t.Fatal(err)
	}

	// Read the window from where the request left it, not from "now".
	if _, ok := lookupPDFPages(root, pdfSourceKey(record), aged.Add(pdfPagesTTL+time.Second)); !ok {
		t.Fatal("a cache hit did not extend the page cache's retention window")
	}
}

// A page directory that advertises itself ready but cannot be merged must be
// reported as such. It is the one verdict that would otherwise masquerade as a
// clean cache hit, and a request logged as a hit while extract_ms is non-zero
// would send whoever reads it after the wrong thing.
func TestCachedTaskPDFReportsAnUnreadablePageDirectory(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	record, collectionID := sourcePDFRecord(t, app)
	writeSourcePDF(t, app, collectionID, record.Id, renderingTestPDF())

	root := s.pdfCacheDir()
	dir := filepath.Join(root, "pages-"+pdfSourceKey(record))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ready"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	// 1.pdf is deliberately absent: the directory looks usable but merges fail.

	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(previous)

	descriptor := describePDF(record, 1, 2, "alice", time.Now())
	output, err := s.cachedTaskPDF(record, descriptor, "proofreader0001")
	if err != nil {
		t.Fatal(err)
	}
	count, err := pdfapi.PageCount(bytes.NewReader(output), nil)
	if err != nil || count != 2 {
		t.Fatalf("degraded preview: count=%d err=%v", count, err)
	}
	if !strings.Contains(logged.String(), `"cache":"pages-unreadable-degraded"`) {
		t.Fatalf("an unreadable page directory was not reported as such: %s", logged.String())
	}
}

func TestSplitPDFPagesKeepsRotationAndOnlyOnePage(t *testing.T) {
	dir := t.TempDir()
	if err := splitPDFPages(bytes.NewReader(renderingTestPDF()), dir, pdfBookBudget); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"1.pdf", "2.pdf", "3.pdf"} {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		ctx, err := pdfapi.ReadAndValidate(f, pdfConfig())
		f.Close()
		if err != nil || ctx.PageCount != 1 {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Shared page resources remain renderable; expansion must respect the budget.
	if err := splitPDFPages(bytes.NewReader(renderingTestPDF()), t.TempDir(), 10); err == nil {
		t.Fatal("expected disk budget error")
	}
}
func TestPDFCacheExpiryAndEviction(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write := func(name string, age time.Duration) {
		p := filepath.Join(root, name)
		if err := os.WriteFile(p, []byte("pdf"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	write("watermark-old.pdf", pdfPreviewTTL+time.Second)
	write("watermark-live.pdf", time.Minute)
	dir := filepath.Join(root, "pages-old")
	_ = os.Mkdir(dir, 0700)
	_ = os.WriteFile(filepath.Join(dir, "1.pdf"), []byte("pdf"), 0600)
	_ = os.Chtimes(dir, now.Add(-pdfPagesTTL-time.Second), now.Add(-pdfPagesTTL-time.Second))
	cleanupPDFCache(root, now, 0)
	for _, name := range []string{"watermark-old.pdf", "pages-old"} {
		if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("not expired: %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "watermark-live.pdf")); err != nil {
		t.Fatal(err)
	}
	cleanupPDFCache(root, now, pdfCacheBudget)
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatal("budget eviction failed")
	}
}
func TestPDFCacheIdentityIsolation(t *testing.T) {
	base := pdfCacheKey("source", "1", "2", "alice", "task")
	for _, parts := range [][]string{{"source", "1", "2", "bob", "task"}, {"replacement", "1", "2", "alice", "task"}, {"source", "2", "3", "alice", "task"}, {"source", "1", "2", "alice", "other"}} {
		if pdfCacheKey(parts...) == base {
			t.Fatal("cross-identity cache collision")
		}
	}
}

func TestOversizedPDFSkipsRepeatedWholeBookPreparation(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	collection, err := app.FindCollectionByNameOrId("project_files")
	if err != nil {
		t.Fatal(err)
	}
	file := core.NewRecord(collection)
	file.Id = "syntheticfile01"
	file.Set("file", "source.pdf")
	file.Set("file_hash", "version-one")
	root := s.pdfCacheDir()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "oversized-"+pdfSourceKey(file))
	if err := os.WriteFile(marker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := s.preparePDFPages(file); !errors.Is(err, errPDFPageBudget) {
			t.Fatalf("retried oversized source: %v", err)
		}
	}
	cleanupPDFCache(root, time.Now().Add(pdfPreviewTTL+time.Minute), 0)
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("oversize marker expired with watermarks")
	}
	cleanupPDFCache(root, time.Now().Add(pdfPagesTTL+time.Second), 0)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("oversize marker did not expire")
	}
}

func TestPDFDescriptorWindowAndIdentity(t *testing.T) {
	app := newSchemaTestApp(t)
	collection, _ := app.FindCollectionByNameOrId("project_files")
	file := core.NewRecord(collection)
	file.Id = "fixturefile0001"
	file.Set("file", "source.pdf")
	file.Set("file_hash", "v1")
	file.Set("page_count", 10)
	now := time.Date(2026, 9, 10, 0, 1, 0, 0, time.UTC)
	first := describePDF(file, 2, 3, "alice", now)
	if first.Key != describePDF(file, 2, 3, "alice", now.Add(time.Minute)).Key {
		t.Fatal("same window not reusable")
	}
	for _, d := range []pdfPreviewDescriptor{describePDF(file, 2, 3, "bob", now), describePDF(file, 3, 4, "alice", now), describePDF(file, 2, 3, "alice", now.Add(pdfPreviewTTL))} {
		if d.Key == first.Key {
			t.Fatal("wrong cache identity")
		}
	}
	if !first.ExpiresAt.Equal(now.Truncate(pdfPreviewTTL).Add(pdfPreviewTTL)) {
		t.Fatal("wrong window expiry")
	}
}
