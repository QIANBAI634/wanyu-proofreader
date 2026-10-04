package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestPageImagesWarmRotatedPagesAndInvalidateSource(t *testing.T) {
	for _, tool := range []string{"pdftoppm", "cwebp"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("render tools unavailable: " + tool)
		}
	}
	app := newSchemaTestApp(t)
	s := newImportService(app)
	file, collectionID := sourcePDFRecord(t, app)
	writeSourcePDF(t, app, collectionID, file.Id, renderingTestPDF())
	if err := s.preparePDFImages(file); err != nil {
		t.Fatal(err)
	}
	for n := 1; n <= 3; n++ {
		path, meta, ok := lookupPageImage(s.pdfCacheDir(), file, n, time.Now())
		if !ok {
			t.Fatalf("page %d absent", n)
		}
		if n == 2 && meta.Width <= meta.Height {
			t.Fatalf("native rotation lost: %+v", meta)
		}
		if n != 2 && meta.Width >= meta.Height {
			t.Fatalf("portrait dimensions: %+v", meta)
		}
		data, err := os.ReadFile(path)
		if err != nil || len(data) < 12 || string(data[8:12]) != "WEBP" {
			t.Fatalf("not WebP: %v", err)
		}
	}
	// A ready marker cannot hide an evicted/corrupt individual page forever.
	if err := os.Remove(filepath.Join(imageDir(s.pdfCacheDir(), file), "2.webp")); err != nil {
		t.Fatal(err)
	}
	if err := s.preparePDFImages(file); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := lookupPageImage(s.pdfCacheDir(), file, 2, time.Now()); !ok {
		t.Fatal("missing cached page was not repaired")
	}
	file.Set("file_hash", "replacement")
	if _, _, ok := lookupPageImage(s.pdfCacheDir(), file, 1, time.Now()); ok {
		t.Fatal("old image survived source replacement")
	}
}

func TestPageImageExpiryAndMissingMetadata(t *testing.T) {
	app := newSchemaTestApp(t)
	file, _ := sourcePDFRecord(t, app)
	root := t.TempDir()
	dir := imageDir(root, file)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"ready": "", "1.json": `{"width":100,"height":200}`, "1.webp": "webp"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	if _, _, ok := lookupPageImage(root, file, 1, now); !ok {
		t.Fatal("warm image missed")
	}
	if _, _, ok := lookupPageImage(root, file, 2, now); ok {
		t.Fatal("missing image accepted")
	}
	expired := now.Add(-pdfPagesTTL - time.Second)
	os.Chtimes(filepath.Join(dir, "ready"), expired, expired)
	if _, _, ok := lookupPageImage(root, file, 1, now); ok {
		t.Fatal("expired image accepted")
	}
	if imageWindowKey(file, "alice", 1, now) == imageWindowKey(file, "bob", 1, now) {
		t.Fatal("URL cache scope crosses users")
	}
}

func TestImageWarmSchedulingIsNonblockingAndDeduplicated(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	file, _ := sourcePDFRecord(t, app)
	s.schedulePDFImages(file)
	s.schedulePDFImages(file)
	if len(s.imageQueue) != 1 || len(s.queue) != 0 {
		t.Fatal("duplicate image job")
	}
	s.imageQueue = make(chan importWork)
	s.pending = map[string]struct{}{}
	s.schedulePDFImages(file)
	if len(s.pending) != 0 {
		t.Fatal("full queue left a phantom pending job")
	}
}

func TestImageWorkerDoesNotBlockImportsAndDeduplicatesRunningWork(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	defer s.imageCancel()
	file, _ := sourcePDFRecord(t, app)
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		s.runPDFImageWorker(func(importWork) { close(started); <-release })
		close(done)
	}()
	defer func() { close(release); s.imageCancel(); <-done }()
	s.schedulePDFImages(file)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("image worker did not start")
	}
	s.schedulePDFImages(file)
	if len(s.imageQueue) != 0 {
		t.Fatal("running image job was queued twice")
	}
	// The real import worker must consume another job while rendering is blocked.
	// An unknown kind is a sentinel: completion still exercises its queue lifecycle.
	importsDone := make(chan struct{})
	s.queue <- importWork{kind: "sentinel", id: "other-import", enqueuedAt: time.Now()}
	close(s.queue)
	go func() { s.runWorker(); close(importsDone) }()
	select {
	case <-importsDone:
	case <-time.After(5 * time.Second):
		t.Fatal("image generation blocked the import worker")
	}
}

func TestImageWorkerPanicReleasesPendingJob(t *testing.T) {
	s := newImportService(newSchemaTestApp(t))
	defer s.imageCancel()
	work := importWork{kind: "pdf-images", id: "file", enqueuedAt: time.Now()}
	s.pending["pdf-images:file"] = struct{}{}
	s.executePDFImageWork(work, func(importWork) { panic("renderer failed") })
	if len(s.pending) != 0 {
		t.Fatal("panic left image permanently pending")
	}
}

func TestImageStagingCleanupPreservesOtherData(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	defer s.imageCancel()
	staging, err := os.MkdirTemp(app.DataDir(), "pdf-images-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "render.pdf"), []byte("orphan"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pdf-images-not-staging", "pdf-preview-cache-v1"} {
		if err := os.Mkdir(filepath.Join(app.DataDir(), name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(app.DataDir(), "pdf-images-123")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	s.cleanupPDFImageStaging()
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatal("orphan staging retained")
	}
	for _, name := range []string{"pdf-images-not-staging", "pdf-preview-cache-v1", "pdf-images-123"} {
		if _, err := os.Stat(filepath.Join(app.DataDir(), name)); err != nil {
			t.Fatalf("unrelated data removed: %s", name)
		}
	}
}

func TestImageCommandTimeoutAndCancellation(t *testing.T) {
	if os.Getenv("WANYU_IMAGE_COMMAND_TEST") == "1" {
		time.Sleep(600 * time.Millisecond)
		return
	}
	t.Setenv("WANYU_IMAGE_COMMAND_TEST", "1")
	// Race-instrumented test binaries wait one second at exit by default,
	// even after PASS. Disable only that helper-process delay so the command
	// budget measures its work; keep race reporting and existing GORACE options.
	t.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0")
	for range 2 {
		if out, err := runImageCommand(context.Background(), time.Second, os.Args[0], "-test.run=^TestImageCommandTimeoutAndCancellation$"); err != nil {
			t.Fatalf("separate process budget: %v %s", err, out)
		}
	}
	if _, err := runImageCommand(context.Background(), 30*time.Millisecond, os.Args[0], "-test.run=^TestImageCommandTimeoutAndCancellation$"); err == nil {
		t.Fatal("process exceeded its timeout")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runImageCommand(ctx, time.Second, os.Args[0], "-test.run=^TestImageCommandTimeoutAndCancellation$"); err == nil {
		t.Fatal("shutdown cancellation ignored")
	}
}

func TestPageImageAccessAudit(t *testing.T) {
	var output bytes.Buffer
	previous, flags := log.Writer(), log.Flags()
	log.SetOutput(&output)
	log.SetFlags(0)
	defer func() { log.SetOutput(previous); log.SetFlags(flags) }()
	logPageImageAccess("reader", "asset", "0123456789abcdef", 2, time.Now())
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"event": "pdf_preview", "user_id": "reader", "asset_id": "asset", "source_key": "0123456789ab", "page_range": "2", "cache": "image-hit"} {
		if event[key] != want {
			t.Fatalf("audit %s = %v", key, event[key])
		}
	}
}
