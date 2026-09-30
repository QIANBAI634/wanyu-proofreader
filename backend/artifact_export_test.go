package main

import (
	"encoding/json"
	"testing"
)

// toSafeCsvCell 对齐 frontend/tests/csvExport.test.js 的全部用例。
func TestToSafeCsvCell(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"普通文本", "普通文本", "普通文本"},
		{"含逗号", "甲,乙", `"甲,乙"`},
		{"含引号", `甲"乙`, `"甲""乙"`},
		{"含换行", "甲\n乙", "\"甲\n乙\""},
		{"等号前缀", "=1+1", "'=1+1"},
		{"加号前缀", "+SUM(A1:A2)", "'+SUM(A1:A2)"},
		{"减号前缀", "-2+3", "'-2+3"},
		{"at前缀", "@cmd", "'@cmd"},
		{"前导空白公式", `  =HYPERLINK("https://example.com")`, `"'  =HYPERLINK(""https://example.com"")"`},
		{"生僻字直通", "𢶀㙟", "𢶀㙟"},
		{"空串", "", ""},
		{"nil", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := toSafeCsvCell(c.in); got != c.want {
				t.Errorf("toSafeCsvCell(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// parseRowJSON 保序解析 + 异常输入。
func TestParseRowJSON(t *testing.T) {
	obj := parseRowJSON(`{"词条":"徛","10":"数字键","释义":"站"}`)
	if obj == nil {
		t.Fatal("expected non-nil")
	}
	if len(obj.keys) != 3 || obj.keys[0] != "词条" || obj.keys[1] != "10" || obj.keys[2] != "释义" {
		t.Fatalf("key order not preserved: %v", obj.keys)
	}

	for _, bad := range []string{"", "   ", `[1,2]`, `"scalar"`, `{"unclosed"`, `not json`} {
		if got := parseRowJSON(bad); got != nil {
			t.Errorf("parseRowJSON(%q) = %v, want nil", bad, got)
		}
	}
}

// orderedRowHeaders 对齐 useStructuredRow.js：saved 在前，实际键在后。
func TestOrderedRowHeaders(t *testing.T) {
	obj := parseRowJSON(`{"词条":"徛","释义":"站"}`)
	saved := []string{"释义", "词条", "不存在的列"}
	got := orderedRowHeaders(saved, obj)
	want := []string{"释义", "词条"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// 保序对象能正确取出值，且数字键作为字符串保留（与 JSON 键名一致）。
func TestOrderedObjectGet(t *testing.T) {
	raw := `{"10":"十","2":"二","词条":"徛"}`
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	// 反直觉但关键：json.Unmarshal 到 map 会保留数字键，但 map 迭代无序。
	// 因此表头并集必须走 parseRowJSON 的保序路径，本测试仅锁定取值正确性。
	obj := parseRowJSON(raw)
	if v, _ := obj.get("10"); v != "十" {
		t.Errorf("get(10) = %v", v)
	}
	if v, _ := obj.get("2"); v != "二" {
		t.Errorf("get(2) = %v", v)
	}
}
