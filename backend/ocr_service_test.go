package main

import (
	"os"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// newOCRTestService 用精简的 import_jobs 集合测试 processOCR 的状态语义，
// 不导入真实 schema（避免 relation/file 必填字段的构造负担）。
func newOCRTestService(t *testing.T) (*importService, *core.Collection) {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.ResetBootstrapState() })

	jobs := &core.Collection{
		Name: "import_jobs",
		Type: core.CollectionTypeBase,
		Fields: core.NewFieldsList(
			&core.TextField{Name: "project"},
			&core.TextField{Name: "mode"},
			&core.TextField{Name: "status"},
			&core.TextField{Name: "project_file"},
			&core.TextField{Name: "error_code"},
			&core.TextField{Name: "error_message"},
			&core.TextField{Name: "inspection_json"},
			&core.DateField{Name: "started_at"},
			&core.DateField{Name: "finished_at"},
		),
	}
	if err := app.Save(jobs); err != nil {
		t.Fatalf("create import_jobs test collection: %v", err)
	}

	svc := &importService{app: app, pending: map[string]struct{}{}, queue: make(chan importWork, 1)}
	return svc, jobs
}

func seedOCRJob(t *testing.T, svc *importService, jobs *core.Collection, status string) string {
	t.Helper()
	record := core.NewRecord(jobs)
	record.Set("project", "proj_test")
	record.Set("mode", "ocr")
	record.Set("status", status)
	record.Set("project_file", "file_test")
	if err := svc.app.Save(record); err != nil {
		t.Fatalf("seed ocr job: %v", err)
	}
	return record.Id
}

// 验收点 4：未配置引擎时，作业必须明确 failed，不得卡在 processing。
func TestProcessOCRDisabledEngineFails(t *testing.T) {
	os.Unsetenv(ocrEngineEnv)
	svc, jobs := newOCRTestService(t)
	jobID := seedOCRJob(t, svc, jobs, "queued")

	svc.processOCR(importWork{kind: "ocr", id: jobID, requestID: "test"})

	loaded, err := svc.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.GetString("status") != "failed" {
		t.Fatalf("expected failed status, got %q", loaded.GetString("status"))
	}
	if loaded.GetString("error_code") != "OCR_ENGINE_DISABLED" {
		t.Fatalf("expected OCR_ENGINE_DISABLED, got %q", loaded.GetString("error_code"))
	}
	if loaded.GetString("error_message") == "" {
		t.Fatal("expected a human-readable error message")
	}
}

// 验收点：配置引擎后，作业能进入 completed 并产出可读的结构化结果。
func TestProcessOCREnabledEngineCompletes(t *testing.T) {
	os.Setenv(ocrEngineEnv, "true")
	t.Cleanup(func() { os.Unsetenv(ocrEngineEnv) })
	svc, jobs := newOCRTestService(t)
	jobID := seedOCRJob(t, svc, jobs, "queued")

	svc.processOCR(importWork{kind: "ocr", id: jobID, requestID: "test"})

	loaded, err := svc.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.GetString("status") != "completed" {
		t.Fatalf("expected completed status, got %q", loaded.GetString("status"))
	}
	if loaded.GetString("inspection_json") == "" {
		t.Fatal("expected structured result in inspection_json")
	}
}

// 验收点 5：作业绝不永久停在 processing。
func TestProcessOCRNeverStuck(t *testing.T) {
	os.Unsetenv(ocrEngineEnv)
	svc, jobs := newOCRTestService(t)
	jobID := seedOCRJob(t, svc, jobs, "processing")

	svc.processOCR(importWork{kind: "ocr", id: jobID, requestID: "test"})

	loaded, err := svc.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	status := loaded.GetString("status")
	if status != "completed" && status != "failed" {
		t.Fatalf("expected terminal status, got %q", status)
	}
}
