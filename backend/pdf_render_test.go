package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
)

// No book contents are embedded here. Page resources are inherited, with a
// standard font, a shared Form XObject and native rotation on the second page.
func renderingTestPDF() []byte {
	objects := []string{"", "<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 300 400] /Resources << /Font << /F1 9 0 R >> /XObject << /Fm1 10 0 R >> >> >>"}
	for i := 0; i < 3; i++ {
		rotation := ""
		if i == 1 {
			rotation = "/Rotate 90"
		}
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R %s /Contents %d 0 R >>", rotation, 6+i))
	}
	stream := func(s string) string { return fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(s), s) }
	for i := 1; i <= 3; i++ {
		objects = append(objects, stream(fmt.Sprintf("BT /F1 18 Tf 20 350 Td (SOURCE_PAGE_%d) Tj ET\n0 0 1 RG 2 w 10 10 280 380 re S\nq 1 0 0 1 20 60 cm /Fm1 Do Q\n", i)))
	}
	objects = append(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	form := "BT /F1 12 Tf 0 0 Td (Shared resource) Tj ET\n"
	objects = append(objects, fmt.Sprintf("<< /Type /XObject /Subtype /Form /BBox [0 -5 150 20] /Resources << /Font << /F1 9 0 R >> >> /Length %d >>\nstream\n%sendstream", len(form), form))
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

func TestTaskPDFRenderingFixture(t *testing.T) {
	for start := 1; start <= 3; start++ {
		end := start + 1
		if end > 3 {
			end = 3
		}
		data, err := buildTaskPDF(bytes.NewReader(renderingTestPDF()), start, end, "Wanyu | synthetic | task | UTC", nil)
		if err != nil {
			t.Fatal(err)
		}
		count, err := pdfapi.PageCount(bytes.NewReader(data), nil)
		if err != nil || count != end-start+1 {
			t.Fatalf("pages=%d err=%v", count, err)
		}
		marked, err := pdfapi.HasWatermarks(bytes.NewReader(data), nil)
		if err != nil || !marked {
			t.Fatalf("watermark=%v err=%v", marked, err)
		}
	}
}

// Opt-in: real inputs and every generated excerpt remain in the caller's local
// directory. CI uses only renderingTestPDF and a disposable directory.
func TestTaskPDFBrowserRegression(t *testing.T) {
	if os.Getenv("FANGJI_PDF_RENDER") != "1" {
		t.Skip("set FANGJI_PDF_RENDER=1 to run PDF.js rendering checks")
	}
	dir := os.Getenv("FANGJI_PDF_OUTPUT")
	if dir == "" {
		dir = t.TempDir()
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	input := os.Getenv("FANGJI_PDF_INPUT")
	data := renderingTestPDF()
	if input != "" {
		data, err = os.ReadFile(input)
		if err != nil {
			t.Fatal(err)
		}
	}
	source := filepath.Join(dir, "source.pdf")
	if err = os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	count, err := validatePDFStructure(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	pagesDir := t.TempDir()
	if err := splitPDFPages(bytes.NewReader(data), pagesDir, pdfBookBudget); err != nil {
		t.Fatal(err)
	}
	const stamp = "Wanyu | regression-user | regression-task | 2026-09-09 UTC"
	for start := 1; start <= count; start++ {
		end := start + 1
		if end > count {
			end = count
		}
		output, err := mergeCachedPDFPages(pagesDir, start, end, stamp, nil)
		if err != nil {
			t.Fatalf("page %d: %v", start, err)
		}
		actual, err := pdfapi.PageCount(bytes.NewReader(output), nil)
		if err != nil || actual != end-start+1 {
			t.Fatalf("page %d: count=%d err=%v", start, actual, err)
		}
		marked, err := pdfapi.HasWatermarks(bytes.NewReader(output), nil)
		if err != nil || !marked {
			t.Fatalf("page %d: watermark=%v err=%v", start, marked, err)
		}
		if err = os.WriteFile(filepath.Join(dir, fmt.Sprintf("task-%d.pdf", start)), output, 0600); err != nil {
			t.Fatal(err)
		}
		if start%25 == 0 || start == count {
			fmt.Printf("Generated %d/%d task PDFs\n", start, count)
		}
	}
	manifest, _ := json.Marshal(map[string]interface{}{"pages": count, "stamp": stamp, "synthetic": input == ""})
	if err = os.WriteFile(filepath.Join(dir, "manifest.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("tests/pdf_render.cjs")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", script, dir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err = cmd.Run(); err != nil {
		t.Fatal(err)
	}
	// Prevent accidental logging of source content: only counts are reported.
	t.Logf("PDF.js verified %d task excerpts", count)
}
