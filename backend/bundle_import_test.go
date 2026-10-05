package main

import (
	"strings"
	"testing"

	"fangji/backend/reviewbundle"
)

func testBundle() reviewbundle.Bundle {
	return reviewbundle.Bundle{
		BundleID:      "rb-unit",
		SchemaVersion: "ReviewBundle/v0",
		SourceSystem:  "xiangsheng-jihe",
		SourceID:      "synthetic-lexicon",
		SourceVersion: "2026-10-02",
		// 列集合与顺序按 requested_fields 投影，所以夹具必须声明它。
		RequestedFields: []string{"headword", "reading"},
		RightsRef:       "src-synthetic-0001",
	}
}

func testEntry(id string, fields ...reviewbundle.Field) reviewbundle.Entry {
	return reviewbundle.Entry{File: "entries.jsonl", Line: 1, EntryID: id, Fields: fields}
}

func TestBuildBundlePageKeepsFieldOrderAndSourceKey(t *testing.T) {
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: " 甲 "},
		reviewbundle.Field{Name: "reading", Value: "kah"},
	)
	page, rowErr := buildBundlePage(testBundle(), entry, 0)
	if rowErr != nil {
		t.Fatalf("unexpected row error: %+v", rowErr)
	}
	if page.entryID != "e-1" || page.sourceSystem != "xiangsheng-jihe" || page.sourceVersion != "2026-10-02" {
		t.Fatalf("source key not carried: %+v", page)
	}
	// 列顺序取 requested_fields（不是条目键序，也不是 Go map 的字母序）；
	// 夹具的键序恰好与 requested_fields 一致，所以这一格同时也钉住了它对不上 map 排序。
	if got, want := page.rowJSON, `{"headword":"甲","reading":"kah"}`; got != want {
		t.Fatalf("rowJSON = %s, want %s", got, want)
	}
	if got, want := page.headersJSON, `["headword","reading"]`; got != want {
		t.Fatalf("headersJSON = %s, want %s", got, want)
	}
	if page.entryText != "甲 kah" {
		t.Fatalf("entryText = %q", page.entryText)
	}
	if page.pdfPage != 0 {
		t.Fatalf("pdfPage = %d, want 0 when the manifest carries no page column", page.pdfPage)
	}
}

func TestBuildBundlePageRoutesPageColumnOutOfHeaders(t *testing.T) {
	bundle := testBundle()
	bundle.RequestedFields = []string{"headword", "pdf_page"}
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: "甲"},
		reviewbundle.Field{Name: "pdf_page", Value: "7"},
	)
	page, rowErr := buildBundlePage(bundle, entry, 10)
	if rowErr != nil {
		t.Fatalf("unexpected row error: %+v", rowErr)
	}
	if page.pdfPage != 7 {
		t.Fatalf("pdfPage = %d, want 7", page.pdfPage)
	}
	// 与 CSV 导入一致：页码列不进表头，它落到 pdf_page。
	if strings.Contains(page.rowJSON, "pdf_page") || page.headersJSON != `["headword"]` {
		t.Fatalf("page column leaked into the row: %s / %s", page.rowJSON, page.headersJSON)
	}

	// 超出当前主 PDF 的页码拒绝落库，而不是把越界页写进去。
	if _, rowErr := buildBundlePage(bundle, entry, 5); rowErr == nil || rowErr.code != "PDF_PAGE_OUT_OF_RANGE" {
		t.Fatalf("out-of-range page was not rejected: %+v", rowErr)
	}
}

// 页码列先于文本断言分流：契约只保证 requested_fields 的键**存在**，不保证值是字符串，
// 所以 JSON 数字页码是能过校验的合法包。判据必须是「能不能取出一个正整数页号」，
// 而不是「这个值是不是字符串」——否则 `3`（更好解析）被整行拒，`"三"`（垃圾）反而通过。
func TestBuildBundlePageAcceptsNonStringPageColumn(t *testing.T) {
	cases := []struct {
		name    string
		value   any
		want    int
		rawNote string
	}{
		{"JSON 数字", float64(3), 3, "encoding/json 把 JSON 数字解成 float64"},
		{"整数浮点", float64(7), 7, "上游写 3 与 3.0 同义"},
		{"数字字符串", "3", 3, "契约 §2 的样例形状"},
		{"带空白的数字字符串", " 12 ", 12, "与文本列同样 TrimSpace"},
		{"解析不出的字符串", "三", 0, "解析不出来按『这一行没有页码』处理，不整行失败"},
		{"小数", float64(3.5), 0, "3.5 不是页号，但不该让整行消失"},
		{"非正数", float64(0), 0, "页号从 1 起"},
		{"负数字符串", "-2", 0, "同 CSV 侧口径"},
		{"布尔", true, 0, "契约允许任意 JSON 类型，非数字形状一律当作没有页码"},
		{"超出 int32", float64(1 << 40), 0, "按没有页码处理，与 Atoi 在超范围字符串上的行为一致"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bundle := testBundle()
			bundle.RequestedFields = []string{"headword", "pdf_page"}
			entry := testEntry("e-1",
				reviewbundle.Field{Name: "headword", Value: "甲"},
				reviewbundle.Field{Name: "pdf_page", Value: tc.value},
			)
			page, rowErr := buildBundlePage(bundle, entry, 100)
			if rowErr != nil {
				t.Fatalf("页码列 %v 不该让整行失败（%s）：%+v", tc.value, tc.rawNote, rowErr)
			}
			if page.pdfPage != tc.want {
				t.Fatalf("pdfPage = %d, want %d", page.pdfPage, tc.want)
			}
			if strings.Contains(page.rowJSON, "pdf_page") {
				t.Fatalf("页码列漏进了行数据：%s", page.rowJSON)
			}
		})
	}
}

// 文本列的文本断言不受上面那条分流影响：非文本值仍然逐条报出来（§7.5）。
func TestBuildBundlePageStillRejectsNonTextContentColumn(t *testing.T) {
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: float64(42)},
		reviewbundle.Field{Name: "reading", Value: "kah"},
	)
	_, rowErr := buildBundlePage(testBundle(), entry, 0)
	if rowErr == nil || rowErr.code != "FIELD_VALUE_NOT_TEXT" {
		t.Fatalf("content column accepted a non-text value: %+v", rowErr)
	}
	if rowErr.column != "headword" {
		t.Fatalf("row error blames %q, want headword", rowErr.column)
	}
}

// 列集合与顺序取 requested_fields，不是条目自己的键顺序：同一包内键序不一致会让
// headersForProject 的按页 union 交错，而多给的键会变成整个项目的一列并下发到校对端。
func TestBuildBundlePageProjectsOntoRequestedFields(t *testing.T) {
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "reading", Value: "kah"},
		reviewbundle.Field{Name: "headword", Value: "甲"},
		reviewbundle.Field{Name: "upstream_note", Value: "不该落库"},
	)
	page, rowErr := buildBundlePage(testBundle(), entry, 0)
	if rowErr != nil {
		t.Fatalf("unexpected row error: %+v", rowErr)
	}
	if got, want := page.rowJSON, `{"headword":"甲","reading":"kah"}`; got != want {
		t.Fatalf("rowJSON = %s, want %s（列序取 requested_fields，多余键不落库）", got, want)
	}
	if got, want := page.headersJSON, `["headword","reading"]`; got != want {
		t.Fatalf("headersJSON = %s, want %s", got, want)
	}
	// 不落库不等于可以静默：被丢掉的键要能被上报。
	if len(page.ignored) != 1 || page.ignored[0] != "upstream_note" {
		t.Fatalf("ignored keys must be reported, got %v", page.ignored)
	}
}

func TestBuildBundlePageReportsRowsTheContractAllows(t *testing.T) {
	// 契约只保证「请求字段都在」，不保证这些值能成为本系统的一个条目。
	empty, rowErr := buildBundlePage(testBundle(), testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: "   "},
		reviewbundle.Field{Name: "reading", Value: ""},
	), 0)
	if rowErr == nil || rowErr.code != "EMPTY_CONTENT" {
		t.Fatalf("blank entry accepted: %+v %+v", empty, rowErr)
	}

	// 非文本值必须逐条报错，而不是被静默 JSON.stringify 成一条看起来正常的字符串。
	_, rowErr = buildBundlePage(testBundle(), testEntry("e-2",
		reviewbundle.Field{Name: "headword", Value: map[string]any{"nested": true}},
		reviewbundle.Field{Name: "reading", Value: "kah"},
	), 0)
	if rowErr == nil || rowErr.code != "FIELD_VALUE_NOT_TEXT" {
		t.Fatalf("non-text value accepted: %+v", rowErr)
	}
	if rowErr.column != "headword" {
		t.Fatalf("row error must name the offending column, got %q", rowErr.column)
	}
}

func TestBundleFileNameStripsPathsAndControlBytes(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"inbound.zip", "inbound.zip"},
		{`C:\Users\x\bundle.zip`, "bundle.zip"},
		{"/tmp/a/bundle.zip", "bundle.zip"},
		{"bad\x00name.zip", "badname.zip"},
		{"   ", "rb-fallback.zip"},
	}
	for _, tc := range cases {
		if got := bundleFileName(tc.raw, "rb-fallback"); got != tc.want {
			t.Errorf("bundleFileName(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
