package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// bookTestPDF builds a synthetic book of the given page count. The three-page
// renderingTestPDF cannot show what #158 is about: a whole-book split only
// becomes visibly different from trimming two pages once the book is long, and
// the reported numbers are the point of the issue.
//
// Like the smaller fixture this embeds no book contents: every page shares one
// Form XObject and one font, with native rotation on the second page.
func bookTestPDF(pages int) []byte {
	if pages < 1 {
		pages = 1
	}
	objects := []string{"", "<< /Type /Catalog /Pages 2 0 R >>"}
	kids := make([]string, 0, pages)
	for i := 0; i < pages; i++ {
		kids = append(kids, fmt.Sprintf("%d 0 R", 3+i))
	}
	objects = append(objects, fmt.Sprintf(
		"<< /Type /Pages /Kids [%s] /Count %d /MediaBox [0 0 300 400] /Resources << /Font << /F1 %d 0 R >> /XObject << /Fm1 %d 0 R >> >> >>",
		joinStrings(kids, " "), pages, 3+pages+pages, 4+pages+pages))
	for i := 0; i < pages; i++ {
		rotation := ""
		if i == 1 {
			rotation = "/Rotate 90"
		}
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R %s /Contents %d 0 R >>", rotation, 3+pages+i))
	}
	stream := func(s string) string { return fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(s), s) }
	// Each page carries its own body rather than a single shared line: a book of
	// uniform one-line pages would understate the per-page work a split does.
	var body bytes.Buffer
	for i := 1; i <= pages; i++ {
		body.Reset()
		fmt.Fprintf(&body, "BT /F1 18 Tf 20 370 Td (SOURCE_PAGE_%d) Tj ET\n", i)
		body.WriteString("0 0 1 RG 2 w 10 10 280 380 re S\nq 1 0 0 1 20 60 cm /Fm1 Do Q\n")
		for line := 0; line < 40; line++ {
			fmt.Fprintf(&body, "BT /F1 9 Tf 20 %d Td (page %d line %d of the scanned dialect entry) Tj ET\n", 350-line*8, i, line)
		}
		objects = append(objects, stream(body.String()))
	}
	objects = append(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	form := "BT /F1 12 Tf 0 0 Td (Shared resource) Tj ET\n"
	objects = append(objects, fmt.Sprintf("<< /Type /XObject /Subtype /Form /BBox [0 -5 150 20] /Resources << /Font << /F1 %d 0 R >> >> /Length %d >>\nstream\n%sendstream",
		3+pages+pages, len(form), form))

	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for id := 1; id < len(objects); id++ {
		offsets[id] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", id, objects[id])
	}
	xref := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(objects))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&out, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects), xref)
	return out.Bytes()
}

func joinStrings(parts []string, sep string) string {
	out := ""
	for i, part := range parts {
		if i > 0 {
			out += sep
		}
		out += part
	}
	return out
}

// benchBookPages is deliberately past the 50 the issue asks about.
const benchBookPages = 60

// Prewarming the whole book, i.e. what the serial import worker does on upload.
func BenchmarkImportPrewarmWholeBook(b *testing.B) {
	source := bookTestPDF(benchBookPages)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := splitPDFPages(bytes.NewReader(source), b.TempDir(), pdfBookBudget); err != nil {
			b.Fatal(err)
		}
	}
}

// The two pages a task shows, trimmed straight out of the source. This is the
// documented degradation path, and now the only thing a request can fall back
// to: it is bounded by the window, not by the book.
func BenchmarkPreviewDegradedTrim(b *testing.B) {
	source := bookTestPDF(benchBookPages)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := buildTaskPDF(bytes.NewReader(source), 10, 11, "Wanyu | bench | book p10-11 | UTC", nil); err != nil {
			b.Fatal(err)
		}
	}
}

// A request served from the pre-split pages: two small files, no book parsing.
func BenchmarkPreviewFromSplitPages(b *testing.B) {
	dir := b.TempDir()
	if err := splitPDFPages(bytes.NewReader(bookTestPDF(benchBookPages)), dir, pdfBookBudget); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := mergeCachedPDFPages(dir, 10, 11, "Wanyu | bench | book p10-11 | UTC", nil); err != nil {
			b.Fatal(err)
		}
	}
}

// ---------------------------------------------------------------------------
// A printable report, because the issue asks for numbers in the PR rather than
// a benchmark that only CI reads. Run with:
//
//	go test -run TestPreviewStageReport -v ./...
func TestPreviewStageReport(t *testing.T) {
	if testing.Short() {
		t.Skip("stage report is a measurement, not an assertion")
	}
	source := bookTestPDF(benchBookPages)
	root := t.TempDir()
	dir := filepath.Join(root, "pages")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}

	prewarmStart := time.Now()
	if err := splitPDFPages(bytes.NewReader(source), dir, pdfBookBudget); err != nil {
		t.Fatal(err)
	}
	prewarm := time.Since(prewarmStart)

	measure := func(label string, run func() error) time.Duration {
		start := time.Now()
		if err := run(); err != nil {
			t.Fatal(err)
		}
		d := time.Since(start)
		t.Logf("%-34s %8.1f ms", label, float64(d.Microseconds())/1000)
		return d
	}

	t.Logf("book under test: %d pages, %d KiB", benchBookPages, len(source)/1024)
	t.Logf("%-34s %8.1f ms", "import prewarm (whole-book split)", float64(prewarm.Microseconds())/1000)
	measure("first access (from split pages)", func() error {
		_, err := mergeCachedPDFPages(dir, 10, 11, "Wanyu | report | book p10-11 | UTC", nil)
		return err
	})
	measure("adjacent window p12-13", func() error {
		_, err := mergeCachedPDFPages(dir, 12, 13, "Wanyu | report | book p12-13 | UTC", nil)
		return err
	})
	measure("repeat access (same window)", func() error {
		_, err := mergeCachedPDFPages(dir, 10, 11, "Wanyu | report | book p10-11 | UTC", nil)
		return err
	})
	measure("degraded: trim two pages, no cache", func() error {
		_, err := buildTaskPDF(bytes.NewReader(source), 10, 11, "Wanyu | report | book p10-11 | UTC", nil)
		return err
	})
}
