package main

import (
	"bytes"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"os"
	"strings"
	"testing"
)

// postSnapshotSelectFields 是本包的 SQL 查询会读、但由**初始快照之后**的迁移追加的列。
//
// newSchemaTestApp 只 import 初始快照、不跑后续迁移（它是给 schema 与安全边界用的），
// 所以队列查询里 SELECT 的 difficulty_tier 必须在这里显式补上，否则测试库与生产库
// schema 不同、SQL 直接报 no such column。TestPostSnapshotFieldsTrackTheirMigrations
// 钉住这份镜像与迁移文件里的取值表一致——镜像会漂，测试不许跟着一起漂。
var postSnapshotSelectFields = []struct {
	Field     string
	Migration string
	Values    []string
}{
	{Field: "difficulty_tier", Migration: "pb_migrations/1789113700_page_difficulty.js", Values: []string{"A", "B", "C", "unknown"}},
}

func newSchemaTestApp(t testing.TB) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.ResetBootstrapState() })
	raw, err := os.ReadFile("pb_migrations/1788940000_initial_schema.js")
	if err != nil {
		t.Fatal(err)
	}
	raw = raw[bytes.IndexByte(raw, '[') : bytes.LastIndex(raw, []byte("];"))+1]
	if err := app.ImportCollectionsByMarshaledJSON(raw, false); err != nil {
		t.Fatal(err)
	}
	pages, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range postSnapshotSelectFields {
		if pages.Fields.GetByName(column.Field) != nil {
			continue
		}
		pages.Fields.Add(&core.SelectField{Name: column.Field, MaxSelect: 1, Values: column.Values})
	}
	if err := app.Save(pages); err != nil {
		t.Fatalf("add post-snapshot pages fields: %v", err)
	}
	return app
}

// TestPostSnapshotFieldsTrackTheirMigrations 从迁移文件源码里取出 TIERS 字面量，
// 与上面那份镜像比对。迁移改档位取值而镜像没跟上时，本包的队列查询会照着旧值算，
// 而生产库按新值存——这种偏差在测试里表现为"全绿但线上分错层"。
func TestPostSnapshotFieldsTrackTheirMigrations(t *testing.T) {
	for _, column := range postSnapshotSelectFields {
		raw, err := os.ReadFile(column.Migration)
		if err != nil {
			t.Fatalf("%s: %v", column.Migration, err)
		}
		text := string(raw)
		marker := "const TIERS = ["
		start := strings.Index(text, marker)
		if start < 0 {
			t.Fatalf("%s 里找不到 TIERS 定义，镜像字段 %s 的取值表已经无据可查", column.Migration, column.Field)
		}
		list := text[start+len(marker):]
		list = list[:strings.Index(list, "]")]
		for _, want := range column.Values {
			if !strings.Contains(list, `"`+want+`"`) {
				t.Errorf("%s 的 TIERS 不含 %q（镜像与迁移已漂移）: %s", column.Migration, want, strings.TrimSpace(list))
			}
		}
		if got, want := strings.Count(list, `"`)/2, len(column.Values); got != want {
			t.Errorf("%s 的 TIERS 有 %d 个值，镜像只列了 %d 个: %s", column.Migration, got, want, strings.TrimSpace(list))
		}
	}
}
func TestFreshSchemaSecurityAndLimits(t *testing.T) {
	app := newSchemaTestApp(t)
	for _, name := range []string{"project_access_secrets", "project_join_attempts", "project_join_source_attempts", "task_leases"} {
		collection, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatal(err)
		}
		if collection.ListRule != nil || collection.ViewRule != nil || collection.CreateRule != nil || collection.UpdateRule != nil || collection.DeleteRule != nil {
			t.Fatalf("%s must not expose native records", name)
		}
	}
	files, err := app.FindCollectionByNameOrId("project_files")
	if err != nil {
		t.Fatal(err)
	}
	field := files.Fields.GetByName("file").(*core.FileField)
	if field.MaxSize != 100*1024*1024 || !field.Protected {
		t.Fatalf("unexpected PDF settings: %+v", field)
	}
	pages, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		t.Fatal(err)
	}
	if pages.Fields.GetByName("row_headers_json") == nil {
		t.Fatal("missing column-order snapshot")
	}
}
