package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/tools/types"
)

// OCR 识别能力开关：未显式启用时，发起识别会得到明确的"不可用"作业，
// 主站与既有导入链路完全不受影响（对应 #121 硬性要求第 4 条）。
// 后续接入真实引擎（数字原生文本提取 / 图像 OCR）时，再定义具体引擎配置。
const ocrEngineEnv = "OCR_ENGINE_ENABLED"

func (s *importService) registerOCR() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/imports/ocr",
			s.startOCR,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// startOCR 是 #121 的发起入口：项目管理员对已上传的主 PDF 发起识别，
// 立即创建一个可跟踪的 import_jobs 作业（mode=ocr，status=queued）。
func (s *importService) startOCR(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	projectID := c.Request.PathValue("projectId")
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		logUploadRejected(requestID, "ocr", projectID, "authorization", "OCR start authorization failed", err)
		return err
	}

	projectFileID, pdfPageLimit := s.primaryPDFSnapshot(projectID)
	if projectFileID == "" {
		return apis.NewBadRequestError("请先上传项目的 PDF 文件，再发起识别。", nil)
	}

	collection, err := s.app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		return apis.NewBadRequestError("导入功能尚未完成数据库初始化。", err)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	form.Load(map[string]any{
		"project":           projectID,
		"created_by":        auth.Id,
		"original_filename": project.GetString("name") + " OCR",
		// OCR 作业不携带源文件；source_file 已在迁移中改为可选。
		// file_hash/file_size 也无需填充（OCR 针对已上传的项目主 PDF）。
		"file_hash":       "",
		"file_size":       0,
		"mode":            "ocr",
		"status":          "queued",
		"total_count":     0,
		"processed_count": 0,
		"success_count":   0,
		"failed_count":    0,
		"project_file":    projectFileID,
		"pdf_page_limit":  pdfPageLimit,
	})
	if err := form.Submit(); err != nil {
		logUploadRejected(requestID, "ocr", projectID, "record_create", "OCR job creation failed", err)
		return apis.NewBadRequestError("创建识别作业失败。", err)
	}

	logUpload("info", "ocr_job_accepted", map[string]any{
		"request_id": requestID,
		"project_id": projectID,
		"job_id":     record.Id,
	})
	s.enqueue(importWork{kind: "ocr", id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

// processOCR 是 OCR 作业的 worker 处理函数。
//
// 当前实现只交付 #121 要求的"链路成立 + 状态可信"，不承诺识别质量（#121 非目标）：
//   - 未配置引擎（OCR_ENGINE_ENABLED 非真值）→ 明确 failed，提示"识别能力未启用"；
//   - 已配置引擎 → 进入 processing 后完成，产出可预览的结构化占位结果，交给 #124 展示。
//
// 数字原生文本提取与图像 OCR 由后续 issue（#123/#125）或真实引擎接入时实现。
func (s *importService) processOCR(work importWork) {
	job, err := s.app.FindRecordById("import_jobs", work.id)
	if err != nil {
		logUpload("error", "ocr_job_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error":      err.Error(),
		})
		return
	}

	job.Set("status", "processing")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	if err := s.app.Save(job); err != nil {
		logUpload("error", "ocr_start_persist_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error":      err.Error(),
		})
		return
	}

	enabled := strings.EqualFold(strings.TrimSpace(os.Getenv(ocrEngineEnv)), "true")
	if !enabled {
		s.markFatal(work, "OCR_ENGINE_DISABLED", "识别能力当前未启用，请配置 OCR 引擎后重试。", fmt.Errorf("OCR_ENGINE_ENABLED is not true"))
		return
	}

	// 引擎已启用：产出结构化占位结果，状态 completed。
	// 真实识别逻辑在此接入（见 #121/#123/#125 及 #120 选型建议书）。
	result := map[string]any{
		"engine":          "pending",
		"project_file_id": job.GetString("project_file"),
		"rows":            []map[string]string{},
		"note":            "识别链路已打通；真实识别结果由后续引擎接入后填充。",
	}
	resultJSON, _ := json.Marshal(result)
	job.Set("status", "completed")
	job.Set("inspection_json", string(resultJSON))
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		s.markFatal(work, "OCR_RESULT_PERSIST_FAILED", "识别结果写入失败。", err)
		return
	}
	logUpload("info", "ocr_job_completed", map[string]any{
		"request_id": work.requestID,
		"job_id":     work.id,
	})
}
