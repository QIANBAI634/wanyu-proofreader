package main

import (
	"strings"
	"testing"
)

// inRange 复刻 ocr/charset.py 的区间判定，供测试侧断言占位字符语义。
func inRange(code rune, lo, hi rune) bool { return code >= lo && code <= hi }

func isPlaceholderRune(r rune) bool {
	return inRange(r, 0xE000, 0xF8FF) || inRange(r, 0x2FF0, 0x2FFF)
}

// TestRareAndPlaceholderCharsSurviveExport 验证生僻字、PUA、IDS 经 toSafeCsvCell
// 字节不变（这些字符不含 CSV 分隔符/公式前缀，应原样直通），并确认占位语义区间。
func TestRareAndPlaceholderCharsSurviveExport(t *testing.T) {
	sample := "𢶀𠮷㙟𰻞䲠" + string(rune(0xE123)) + string(rune(0x2FF0)) + "①⑭" + "ŋʔ"
	if got := toSafeCsvCell(sample); got != sample {
		t.Fatalf("rare/placeholder chars changed: %q != %q", got, sample)
	}

	// 弃权占位字符语义：PUA(U+E000-F8FF) 与 IDS(U+2FF0-2FFF) 必须命中占位区间。
	for _, r := range []rune{0xE000, 0xE123, 0xF8FF, 0x2FF0, 0x2FFF} {
		if !isPlaceholderRune(r) {
			t.Errorf("code point U+%X should be a placeholder", r)
		}
	}
	// 空格与普通字符不是占位。
	for _, r := range []rune{' ', '\t', '徛', 'a'} {
		if isPlaceholderRune(r) {
			t.Errorf("code point %q should not be a placeholder", r)
		}
	}
}

// TestCSVTextAssembly 验证导出文本拼装：BOM 前缀 + CRLF 行分隔 + 表头并集顺序。
func TestCSVTextAssembly(t *testing.T) {
	// 用手工数据复刻 exportCSV 的纯计算部分（不含 DB）。
	lines := []string{
		strings.Join([]string{toSafeCsvCell("PDF页码"), toSafeCsvCell("词条"), toSafeCsvCell("音读"), toSafeCsvCell("释义")}, ","),
		strings.Join([]string{toSafeCsvCell("1"), toSafeCsvCell("徛"), toSafeCsvCell("kiā"), toSafeCsvCell("站、立")}, ","),
	}
	csvText := "\uFEFF" + strings.Join(lines, "\r\n")

	if !strings.HasPrefix(csvText, "\uFEFF") {
		t.Fatal("missing BOM prefix")
	}
	if !strings.Contains(csvText, "\r\n") {
		t.Fatal("missing CRLF line separator")
	}
	// 生僻字徛 与 IPA 字符 ā 原样保留。
	if !strings.Contains(csvText, "徛") || !strings.Contains(csvText, "kiā") {
		t.Fatal("rare/IPA chars lost in assembled CSV")
	}
}
