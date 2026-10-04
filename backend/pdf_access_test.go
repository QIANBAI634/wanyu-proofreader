package main

import (
	"bytes"
	"context"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"testing"
)

func TestTaskPDFContainsOnlySelectedPagesWithWatermark(t *testing.T) {
	for _, pair := range [][2]int{{2, 3}, {4, 4}} {
		out, err := buildTaskPDF(bytes.NewReader(minimalTestPDF(4)), pair[0], pair[1], "Wanyu | test-user | task | 2026-09-09 UTC", nil)
		if err != nil {
			t.Fatal(err)
		}
		count, err := pdfapi.PageCount(context.Background(), bytes.NewReader(out), nil)
		if err != nil || count != pair[1]-pair[0]+1 {
			t.Fatalf("pages=%d err=%v", count, err)
		}
		marked, err := pdfapi.HasWatermarks(context.Background(), bytes.NewReader(out), nil)
		if err != nil || !marked {
			t.Fatalf("watermark=%v err=%v", marked, err)
		}
	}
}
