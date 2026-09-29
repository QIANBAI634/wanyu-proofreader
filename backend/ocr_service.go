package main

import (
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
		"mode":              "ocr",
		"status":            "queued",
		"total_count":       0,
		"processed_count":   0,
		"success_count":     0,
		"failed_count":      0,
		"project_file":      projectFileID,
		"pdf_page_limit":    pdfPageLimit,
		// OCR 作业无源文件，但 file_hash 参与 idx_import_jobs_dedup 唯一索引。
		// 用一个每次唯一的随机值作判别，避免同项目第二次发起撞 UNIQUE 约束；
		// 也明确"OCR 作业不做文件级去重"（每次发起都是独立作业）。
		"file_hash": "ocr-" + newRequestID(),
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
//   - 已配置引擎但真实引擎尚未接入 → 明确 failed（OCR_ENGINE_PENDING），
//     绝不用 completed 宣告"识别完成"，避免对外宣称具备真实识别能力。
//
// 并发限制（#121 已知坑）：OCR 与 CSV/PDF 共用 runWorker 的单串行 goroutine。
// 接入真实引擎前必须改为独立 worker / 并发上限，否则一次识别会阻塞全部导入——
// 由 #122 承接。当前占位实现无耗时工作，此限制暂无实际影响。
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

	// 引擎开关虽为真，但真实识别引擎尚未接入。这里绝不能用 completed 宣告
	// 「识别完成、结果已生成」——那是对外宣称具备真实识别能力，违反 #121
	// 验收标准最后一条。占位阶段明确落为失败态，等 #122/#123/#125 接入真引擎
	// 后再产出可预览的结构化结果。
	s.markFatal(work, "OCR_ENGINE_PENDING", "识别引擎尚未接入，当前无法产出识别结果。", fmt.Errorf("OCR engine integration is pending (#122/#123/#125)"))
}
