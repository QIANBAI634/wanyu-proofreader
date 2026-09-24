package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfmodel "github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"github.com/pocketbase/pocketbase/forms"

	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/types"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const (
	maxCSVBytes          = 50 * 1024 * 1024
	maxPDFBytes          = 100 * 1024 * 1024
	batchSize            = 250
	artifactCleanupBatch = 500
	pdfValidator         = "pdfcpu v0.8.1"
)

type importWork struct {
	kind       string
	id         string
	requestID  string
	enqueuedAt time.Time
}

func newRequestID() string {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err == nil {
		return hex.EncodeToString(random)
	}
	return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
}

func ensureRequestID(c *core.RequestEvent) string {
	requestID := strings.TrimSpace(c.Request.Header.Get("X-Request-ID"))
	if requestID == "" {
		requestID = newRequestID()
	}
	c.Response.Header().Set("X-Request-ID", requestID)
	return requestID
}

func logUpload(level, event string, fields map[string]any) {
	payload := map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"level":     level,
		"component": "upload_service",
		"event":     event,
	}
	for key, value := range fields {
		if value != nil && value != "" {
			payload[key] = value
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("upload log marshal failed event=%s: %v", event, err)
		return
	}
	log.Print(string(encoded))
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func logUploadRejected(requestID, kind, projectID, stage, message string, err error) {
	logUpload("warn", "upload_rejected", map[string]any{
		"request_id": requestID,
		"kind":       kind,
		"project_id": projectID,
		"stage":      stage,
		"message":    message,
		"error":      errorText(err),
	})
}

type importService struct {
	app        *pocketbase.PocketBase
	queue      chan importWork
	mu         sync.Mutex
	pending    map[string]struct{}
	pdfUploads *pdfUploadPool
}

func newImportService(app *pocketbase.PocketBase) *importService {
	return &importService{
		app:     app,
		queue:   make(chan importWork, 1024),
		pending: map[string]struct{}{},
	}
}

func (s *importService) register() {
	s.registerChunkUploads()
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/imports/csv",
			s.uploadCSV).Bind(apis.BodyLimit(51*1024*1024),
			apis.RequireAuth("users"))
		e.Router.POST(
			"/api/fangji/imports/{jobId}/commit",
			s.commitCSVImport).Bind(apis.RequireAuth("users"))
		e.Router.POST(
			"/api/fangji/projects/{projectId}/files/pdf",
			s.uploadPDF).Bind(apis.BodyLimit(maxPDFBytes+1024*1024), // Allow multipart framing.
			apis.RequireAuth("users"))

		go s.runWorker()
		go s.recoverPendingWork()
		return e.Next()
	})
}

func (s *importService) requireProjectManager(c *core.RequestEvent, projectID string) (*core.Record, *core.Record, error) {
	auth := c.Auth
	if auth == nil {
		return nil, nil, apis.NewUnauthorizedError("登录状态已失效，请重新登录。", nil)
	}
	project, err := s.findProject(projectID)
	if err != nil {
		return nil, nil, err
	}
	if auth.GetString("role") == "platform_admin" || project.GetString("admin") == auth.Id {
		return auth, project, nil
	}
	memberships, err := s.app.FindRecordsByFilter(
		"project_memberships",
		fmt.Sprintf(`project = %q && user = %q && role = "manager"`, projectID, auth.Id),
		"",
		1,
		0,
	)
	if err == nil && len(memberships) > 0 {
		return auth, project, nil
	}
	return nil, nil, apis.NewForbiddenError("只有项目所有者或管理员可以上传项目文件。", err)
}

func (s *importService) findProject(projectID string) (*core.Record, error) {
	project, err := s.app.FindRecordById("projects", projectID)
	if err != nil || project == nil {
		return nil, apis.NewNotFoundError("项目不存在或已被删除。", err)
	}
	return project, nil
}

func (s *importService) uploadCSV(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	inspectOnly := strings.EqualFold(strings.TrimSpace(c.Request.FormValue("inspect_only")), "true")
	projectID := c.Request.PathValue("projectId")
	auth, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "authorization", "CSV upload authorization failed", err)
		return err
	}
	logUpload("info", "upload_received", map[string]any{
		"request_id":   requestID,
		"kind":         "csv",
		"project_id":   projectID,
		"user_id":      auth.Id,
		"inspect_only": inspectOnly,
	})

	uploaded, header, err := c.Request.FormFile("file")
	if uploaded != nil {
		defer uploaded.Close()
	}
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "multipart", "CSV file is missing", err)
		return apis.NewBadRequestError("请选择要导入的 CSV 文件。", err)
	}
	if err := validateUploadHeader(header, ".csv", maxCSVBytes); err != nil {
		logUploadRejected(requestID, "csv", projectID, "header_validation", err.Error(), err)
		return apis.NewBadRequestError(err.Error(), nil)
	}

	hash, err := hashMultipartFile(header)
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "hash", "CSV hashing failed", err)
		return apis.NewBadRequestError("无法读取上传的 CSV 文件。", err)
	}

	projectFileID, pdfPageLimit := s.primaryPDFSnapshot(projectID)
	filter := fmt.Sprintf(
		`project = %q && file_hash = %q && mode = "skip_invalid" && project_file = %q && status != "failed"`,
		projectID,
		hash,
		projectFileID,
	)
	existing, findErr := s.app.FindRecordsByFilter("import_jobs", filter, "-created", 1, 0)
	if findErr != nil {
		logUpload("error", "dedup_lookup_failed", map[string]any{
			"request_id": requestID,
			"kind":       "csv",
			"project_id": projectID,
			"file_hash":  hash,
			"error":      findErr.Error(),
		})
	}
	if len(existing) > 0 {
		logUpload("info", "upload_deduplicated", map[string]any{
			"request_id": requestID,
			"kind":       "csv",
			"project_id": projectID,
			"job_id":     existing[0].Id,
			"file_name":  header.Filename,
			"file_size":  header.Size,
			"file_hash":  hash,
		})
		return c.JSON(http.StatusOK, existing[0])
	}

	collection, err := s.app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		return apis.NewBadRequestError("导入功能尚未完成数据库初始化。", err)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	initialStatus := "queued"
	workKind := "csv"
	if inspectOnly {
		initialStatus = "inspecting"
		workKind = "csv_inspect"
	}
	form.Load(map[string]any{
		"project":               projectID,
		"created_by":            auth.Id,
		"original_filename":     header.Filename,
		"file_hash":             hash,
		"file_size":             header.Size,
		"mode":                  "skip_invalid",
		"status":                initialStatus,
		"total_count":           0,
		"processed_count":       0,
		"success_count":         0,
		"failed_count":          0,
		"project_file":          projectFileID,
		"pdf_page_limit":        pdfPageLimit,
		"pdf_snapshot_captured": true,
	})
	file, err := filesystem.NewFileFromMultipart(header)
	if err != nil {
		return apis.NewBadRequestError("无法读取上传的 CSV 文件。", err)
	}
	record.Set("source_file", file)
	if err := form.Submit(); err != nil {
		// A concurrent duplicate upload may have won the unique index race.
		existing, findErr := s.app.FindRecordsByFilter("import_jobs", filter, "-created", 1, 0)
		if findErr != nil {
			logUpload("error", "dedup_lookup_failed", map[string]any{
				"request_id": requestID,
				"kind":       "csv",
				"project_id": projectID,
				"file_hash":  hash,
				"error":      findErr.Error(),
			})
		}
		if len(existing) > 0 {
			logUpload("info", "upload_deduplicated", map[string]any{
				"request_id": requestID,
				"kind":       "csv",
				"project_id": projectID,
				"job_id":     existing[0].Id,
				"file_name":  header.Filename,
				"file_size":  header.Size,
				"file_hash":  hash,
			})
			return c.JSON(http.StatusOK, existing[0])
		}
		logUploadRejected(requestID, "csv", projectID, "record_create", "CSV import job creation failed", err)
		return apis.NewBadRequestError("创建 CSV 导入作业失败。", err)
	}

	logUpload("info", "upload_accepted", map[string]any{
		"request_id": requestID,
		"kind":       "csv",
		"project_id": projectID,
		"job_id":     record.Id,
		"file_name":  header.Filename,
		"file_size":  header.Size,
		"file_hash":  hash,
	})
	s.enqueue(importWork{kind: workKind, id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

func (s *importService) commitCSVImport(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	jobID := c.Request.PathValue("jobId")
	job, err := s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		logUploadRejected(requestID, "csv", "", "job_lookup", "CSV inspection job was not found", err)
		return apis.NewNotFoundError("CSV 预检作业不存在或已被删除。", err)
	}
	if _, _, err := s.requireProjectManager(c, job.GetString("project")); err != nil {
		logUploadRejected(requestID, "csv", job.GetString("project"), "authorization", "CSV commit authorization failed", err)
		return err
	}
	if job.GetString("status") != "validated" {
		return apis.NewBadRequestError("CSV 只有在后端预检通过后才能确认导入。", nil)
	}
	job.Set("status", "queued")
	job.Set("started_at", "")
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	if err := s.app.Save(job); err != nil {
		logUploadRejected(requestID, "csv", job.GetString("project"), "commit_persist", "CSV commit failed", err)
		return apis.NewBadRequestError("无法确认 CSV 导入。", err)
	}
	logUpload("info", "csv_commit_requested", map[string]any{
		"request_id": requestID,
		"kind":       "csv",
		"job_id":     jobID,
		"project_id": job.GetString("project"),
		"file_name":  job.GetString("original_filename"),
		"file_size":  job.GetInt("file_size"),
		"file_hash":  job.GetString("file_hash"),
	})
	s.enqueue(importWork{kind: "csv", id: jobID, requestID: requestID})
	return c.JSON(http.StatusAccepted, job)
}

func (s *importService) uploadPDF(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	projectID := c.Request.PathValue("projectId")
	_, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "authorization", "PDF upload authorization failed", err)
		return err
	}
	logUpload("info", "upload_received", map[string]any{
		"request_id": requestID,
		"kind":       "pdf",
		"project_id": projectID,
	})

	uploaded, header, err := c.Request.FormFile("file")
	if uploaded != nil {
		defer uploaded.Close()
	}
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "multipart", "PDF file is missing", err)
		return apis.NewBadRequestError("请选择要上传的 PDF 文件。", err)
	}
	if err := validateUploadHeader(header, ".pdf", maxPDFBytes); err != nil {
		logUploadRejected(requestID, "pdf", projectID, "header_validation", err.Error(), err)
		return apis.NewBadRequestError(err.Error(), nil)
	}
	validSignature, err := multipartHasPrefix(header, []byte("%PDF-"))
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "signature_read", "PDF signature read failed", err)
		return apis.NewBadRequestError("无法读取上传的 PDF 文件。", err)
	}
	if !validSignature {
		logUploadRejected(requestID, "pdf", projectID, "signature_validation", "PDF signature is invalid", nil)
		return apis.NewBadRequestError("文件内容不是有效的 PDF。", nil)
	}
	hash, err := hashMultipartFile(header)
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "hash", "PDF hashing failed", err)
		return apis.NewBadRequestError("无法读取上传的 PDF 文件。", err)
	}

	collection, err := s.app.FindCollectionByNameOrId("project_files")
	if err != nil {
		return apis.NewBadRequestError("PDF 文件集合不存在。", err)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	form.Load(map[string]any{
		"project":           projectID,
		"original_filename": header.Filename,
		"status":            "processing",
		"file_hash":         hash,
		"file_size":         header.Size,
		"error_code":        "",
		"error_message":     "",
	})
	file, err := filesystem.NewFileFromMultipart(header)
	if err != nil {
		return apis.NewBadRequestError("无法读取上传的 PDF 文件。", err)
	}
	record.Set("file", file)
	if err := form.Submit(); err != nil {
		logUploadRejected(requestID, "pdf", projectID, "record_create", "PDF record creation failed", err)
		return apis.NewBadRequestError("上传 PDF 失败。", err)
	}

	logUpload("info", "upload_accepted", map[string]any{
		"request_id": requestID,
		"kind":       "pdf",
		"project_id": projectID,
		"file_id":    record.Id,
		"file_name":  header.Filename,
		"file_size":  header.Size,
		"file_hash":  hash,
	})
	s.enqueue(importWork{kind: "pdf", id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

func validateUploadHeader(header *multipart.FileHeader, extension string, maxBytes int64) error {
	if header == nil || header.Size <= 0 {
		return errors.New("上传文件为空。")
	}
	if header.Size > maxBytes {
		return fmt.Errorf("文件超过 %d MB 上限。", maxBytes/(1024*1024))
	}
	if !strings.EqualFold(filepath.Ext(header.Filename), extension) {
		return fmt.Errorf("文件扩展名必须为 %s。", extension)
	}
	return nil
}

func hashMultipartFile(header *multipart.FileHeader) (string, error) {
	file, err := header.Open()
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func multipartHasPrefix(header *multipart.FileHeader, expected []byte) (bool, error) {
	file, err := header.Open()
	if err != nil {
		return false, err
	}
	defer file.Close()

	actual := make([]byte, len(expected))
	if _, err := io.ReadFull(file, actual); err != nil {
		return false, nil
	}
	return string(actual) == string(expected), nil
}

func (s *importService) enqueue(work importWork) {
	if work.requestID == "" {
		work.requestID = "recovery-" + work.id
	}
	if work.enqueuedAt.IsZero() {
		work.enqueuedAt = time.Now()
	}
	key := work.kind + ":" + work.id
	s.mu.Lock()
	if _, exists := s.pending[key]; exists {
		s.mu.Unlock()
		logUpload("info", "work_deduplicated", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
		})
		return
	}
	s.pending[key] = struct{}{}
	s.mu.Unlock()
	logUpload("info", "work_queued", map[string]any{
		"request_id": work.requestID,
		"kind":       work.kind,
		"record_id":  work.id,
	})
	s.queue <- work
}

func (s *importService) finishWork(work importWork) {
	s.mu.Lock()
	delete(s.pending, work.kind+":"+work.id)
	s.mu.Unlock()
}

func (s *importService) runWorker() {
	for work := range s.queue {
		func() {
			startedAt := time.Now()
			logUpload("info", "work_started", map[string]any{
				"request_id":    work.requestID,
				"kind":          work.kind,
				"record_id":     work.id,
				"queue_wait_ms": startedAt.Sub(work.enqueuedAt).Milliseconds(),
			})
			defer s.finishWork(work)
			defer func() {
				logUpload("info", "work_finished", map[string]any{
					"request_id":  work.requestID,
					"kind":        work.kind,
					"record_id":   work.id,
					"duration_ms": time.Since(startedAt).Milliseconds(),
				})
			}()
			defer func() {
				if recovered := recover(); recovered != nil {
					panicErr := fmt.Errorf("%v", recovered)
					logUpload("error", "worker_panic", map[string]any{
						"request_id": work.requestID,
						"kind":       work.kind,
						"record_id":  work.id,
						"error":      panicErr.Error(),
					})
					s.markFatal(work, "WORKER_PANIC", "服务器处理文件时发生内部错误。", panicErr)
				}
			}()
			switch work.kind {
			case "csv_inspect":
				s.processCSVInspection(work)
			case "csv":
				s.processCSV(work)
			case "pdf":
				s.processPDF(work)
			case "ocr":
				s.processOCR(work)
			}
		}()
	}
}

func (s *importService) recoverPendingWork() {
	jobs, err := s.app.FindRecordsByFilter(
		"import_jobs",
		`status = "queued" || status = "processing" || status = "inspecting"`,
		"created",
		10000,
		0,
	)
	if err != nil {
		logUpload("error", "recovery_query_failed", map[string]any{
			"kind":  "csv",
			"error": err.Error(),
		})
	} else {
		for _, job := range jobs {
			kind := "csv"
			if job.GetString("status") == "inspecting" {
				kind = "csv_inspect"
			}
			if job.GetString("mode") == "ocr" {
				kind = "ocr"
			}
			s.enqueue(importWork{kind: kind, id: job.Id, requestID: "recovery-" + job.Id})
		}
	}

	files, err := s.app.FindRecordsByFilter(
		"project_files",
		`status = "processing"`,
		"created",
		10000,
		0,
	)
	if err != nil {
		logUpload("error", "recovery_query_failed", map[string]any{
			"kind":  "pdf",
			"error": err.Error(),
		})
	} else {
		for _, file := range files {
			s.enqueue(importWork{kind: "pdf", id: file.Id, requestID: "recovery-" + file.Id})
		}
	}
	logUpload("info", "recovery_scan_completed", map[string]any{
		"csv_jobs":  len(jobs),
		"pdf_files": len(files),
	})
}

func (s *importService) markFatal(work importWork, code, message string, cause error) {
	collection := "import_jobs"
	if work.kind == "pdf" {
		collection = "project_files"
	}
	record, err := s.app.FindRecordById(collection, work.id)
	if err != nil {
		logUpload("error", "fatal_record_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
			"error_code": code,
			"error":      err.Error(),
			"cause":      errorText(cause),
		})
		return
	}
	record.Set("status", "failed")
	if work.kind == "pdf" {
		record.Set("status", "error")
	}
	record.Set("error_code", code)
	record.Set("error_message", message)
	if work.kind == "csv" || work.kind == "csv_inspect" || work.kind == "ocr" {
		record.Set("finished_at", types.NowDateTime())
	}
	var cleanup func() error
	if work.kind == "csv" {
		cleanup = func() error {
			return s.clearJobPages(work.id)
		}
	}
	persistErr, cleanupErr := persistBeforeCleanup(
		func() error { return s.app.Save(record) },
		cleanup,
	)
	if persistErr != nil {
		logUpload("error", "fatal_status_persist_failed", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
			"project_id": record.GetString("project"),
			"error_code": code,
			"error":      persistErr.Error(),
		})
		return
	}
	if cleanupErr != nil {
		message += " 暂存条目自动清理失败，请联系管理员处理。"
		record.Set("error_message", message)
		logUpload("error", "failed_csv_staging_cleanup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error_code": code,
			"error":      cleanupErr.Error(),
		})
		if err := s.app.Save(record); err != nil {
			logUpload("error", "fatal_cleanup_message_persist_failed", map[string]any{
				"request_id": work.requestID,
				"kind":       work.kind,
				"record_id":  work.id,
				"project_id": record.GetString("project"),
				"error_code": code,
				"error":      err.Error(),
			})
		}
	}
	logUpload("error", "work_failed", map[string]any{
		"request_id":    work.requestID,
		"kind":          work.kind,
		"record_id":     work.id,
		"project_id":    record.GetString("project"),
		"file_name":     record.GetString("original_filename"),
		"file_size":     record.GetInt("file_size"),
		"file_hash":     record.GetString("file_hash"),
		"error_code":    code,
		"message":       message,
		"error":         errorText(cause),
		"cleanup_error": errorText(cleanupErr),
	})
}

func persistBeforeCleanup(persist func() error, cleanup func() error) (persistErr, cleanupErr error) {
	if err := persist(); err != nil {
		return err, nil
	}
	if cleanup == nil {
		return nil, nil
	}
	return nil, cleanup()
}

func (s *importService) processPDF(work importWork) {
	recordID := work.id
	record, err := s.app.FindRecordById("project_files", recordID)
	if err != nil {
		logUpload("error", "pdf_record_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"file_id":    recordID,
			"error":      err.Error(),
		})
		return
	}
	reader, closeFile, err := s.openRecordFile(record, "file")
	if err != nil {
		s.markFatal(work, "PDF_FILE_MISSING", "服务器找不到已上传的 PDF 文件。", err)
		return
	}
	defer closeFile()

	header := make([]byte, 5)
	if _, err := io.ReadFull(reader, header); err != nil || string(header) != "%PDF-" {
		s.markFatal(work, "INVALID_PDF_SIGNATURE", "文件内容不是有效的 PDF。", err)
		return
	}
	pageCount, err := validatePDFStructure(reader)
	if err != nil {
		s.markFatal(work, "PDF_DEEP_VALIDATION_FAILED", "PDF 文件结构损坏、被截断或无法解析。", err)
		return
	}

	// Prepare private single-page sources in the serial import worker.
	pdfCacheMu.Lock()
	_, cacheErr := s.preparePDFPages(record)
	pdfCacheMu.Unlock()
	if cacheErr != nil {
		logUpload("warn", "pdf_cache_prepare_failed", map[string]any{"file_id": recordID, "error": cacheErr.Error()})
	}
	validatedAt := types.NowDateTime()
	projectID := record.GetString("project")
	err = s.app.RunInTransaction(func(txDao core.App) error {
		previous, err := txDao.FindRecordsByFilter(
			"project_files",
			fmt.Sprintf(`project = %q && is_primary = true && id != %q`, projectID, recordID),
			"-created",
			1000,
			0,
		)
		if err != nil {
			return err
		}
		for _, old := range previous {
			old.Set("is_primary", false)
			old.Set("superseded_at", validatedAt)
			if err := txDao.Save(old); err != nil {
				return err
			}
		}
		current, err := txDao.FindRecordById("project_files", recordID)
		if err != nil {
			return err
		}
		current.Set("status", "ready")
		current.Set("error_code", "")
		current.Set("error_message", "")
		current.Set("page_count", pageCount)
		current.Set("validation_tool", pdfValidator)
		current.Set("validated_at", validatedAt)
		current.Set("is_primary", true)
		current.Set("superseded_at", "")
		return txDao.Save(current)
	})
	if err != nil {
		s.markFatal(work, "PDF_STATUS_UPDATE_FAILED", "PDF 已验证，但主文件状态更新失败。", err)
		return
	}
	logUpload("info", "pdf_ready", map[string]any{
		"request_id": work.requestID,
		"kind":       "pdf",
		"file_id":    recordID,
		"project_id": projectID,
		"file_name":  record.GetString("original_filename"),
		"file_size":  record.GetInt("file_size"),
		"file_hash":  record.GetString("file_hash"),
		"page_count": pageCount,
		"validator":  pdfValidator,
	})
}

func validatePDFStructure(reader io.ReadSeeker) (int, error) {
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	pdfapi.DisableConfigDir()
	configuration := pdfmodel.NewDefaultConfiguration()
	configuration.ValidationMode = pdfmodel.ValidationRelaxed
	context, err := pdfapi.ReadAndValidate(reader, configuration)
	if err != nil {
		return 0, err
	}
	if context.PageCount < 1 {
		return 0, errors.New("PDF contains no pages")
	}
	return context.PageCount, nil
}

func (s *importService) openRecordFile(record *core.Record, field string) (io.ReadSeeker, func(), error) {
	filename := record.GetString(field)
	if filename == "" {
		return nil, func() {}, errors.New("missing file field")
	}
	fs, err := s.app.NewFilesystem()
	if err != nil {
		return nil, func() {}, err
	}
	reader, err := fs.GetFile(path.Join(record.BaseFilesPath(), filename))
	if err != nil {
		fs.Close()
		return nil, func() {}, err
	}
	closeFn := func() {
		reader.Close()
		fs.Close()
	}
	return reader, closeFn, nil
}

type csvPage struct {
	line        int
	pdfPage     int
	rowJSON     string
	headersJSON string
	entryText   string
}

type csvCounters struct {
	total     int
	processed int
	success   int
	failed    int
}

type csvInspection struct {
	Encoding     string              `json:"encoding"`
	Headers      []string            `json:"headers"`
	PDFPageField string              `json:"pdf_page_field"`
	TotalRows    int                 `json:"total_rows"`
	ValidRows    int                 `json:"valid_rows"`
	InvalidRows  int                 `json:"invalid_rows"`
	MinPDFPage   int                 `json:"min_pdf_page"`
	MaxPDFPage   int                 `json:"max_pdf_page"`
	Preview      []map[string]string `json:"preview"`
}

func (s *importService) processCSVInspection(work importWork) {
	job, err := s.app.FindRecordById("import_jobs", work.id)
	if err != nil {
		logUpload("error", "csv_inspection_job_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error":      err.Error(),
		})
		return
	}
	job.Set("status", "inspecting")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	job.Set("inspection_json", "")
	projectFileID := job.GetString("project_file")
	pdfPageLimit := job.GetInt("pdf_page_limit")
	if !job.GetBool("pdf_snapshot_captured") {
		projectFileID, pdfPageLimit = s.primaryPDFSnapshot(job.GetString("project"))
		job.Set("project_file", projectFileID)
		job.Set("pdf_page_limit", pdfPageLimit)
		job.Set("pdf_snapshot_captured", true)
	}
	if err := s.app.Save(job); err != nil {
		logUpload("error", "csv_inspection_start_persist_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error":      err.Error(),
		})
		return
	}
	if err := s.clearJobArtifacts(work.id); err != nil {
		s.markFatal(work, "JOB_RECOVERY_CLEANUP_FAILED", "无法清理该作业上次未完成的预检结果。", err)
		return
	}

	file, closeFile, err := s.openRecordFile(job, "source_file")
	if err != nil {
		s.markFatal(work, "CSV_FILE_MISSING", "服务器找不到已上传的 CSV 文件。", err)
		return
	}
	defer closeFile()
	decoded, encodingName, err := decodedCSVReader(file)
	if err != nil {
		s.markFatal(work, "CSV_ENCODING_ERROR", "CSV 编码无法识别，请使用 UTF-8 或 GB18030。", err)
		return
	}
	csvReader := csv.NewReader(decoded)
	csvReader.FieldsPerRecord = -1
	csvReader.ReuseRecord = false
	rawHeaders, err := csvReader.Read()
	if err != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", csvReadErrorMessage(err), err)
		return
	}
	headers, pdfIndex, pdfPageField, err := resolveCSVHeaders(rawHeaders)
	if err != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", err.Error(), err)
		return
	}

	inspection := csvInspection{
		Encoding:     encodingName,
		Headers:      headers,
		PDFPageField: pdfPageField,
		Preview:      make([]map[string]string, 0, 5),
	}
	for {
		values, readErr := csvReader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		inspection.TotalRows++
		if readErr != nil {
			inspection.InvalidRows++
			line := csvErrorLine(readErr)
			s.addJobError(work.id, line, "", "CSV_PARSE_ERROR", csvReadErrorMessage(readErr), "", false)
			continue
		}
		line, _ := csvReader.FieldPos(0)
		page, validationErr := buildCSVPageWithLimit(headers, values, pdfIndex, line, pdfPageLimit)
		if validationErr != nil {
			inspection.InvalidRows++
			s.addJobError(
				work.id,
				validationErr.line,
				validationErr.column,
				validationErr.code,
				validationErr.message,
				validationErr.rawValue,
				false,
			)
			continue
		}
		inspection.ValidRows++
		if inspection.MinPDFPage == 0 || page.pdfPage < inspection.MinPDFPage {
			inspection.MinPDFPage = page.pdfPage
		}
		if page.pdfPage > inspection.MaxPDFPage {
			inspection.MaxPDFPage = page.pdfPage
		}
		if len(inspection.Preview) < 5 {
			row := make(map[string]string, len(headers))
			for index, header := range headers {
				if index < len(values) {
					row[header] = values[index]
				}
			}
			inspection.Preview = append(inspection.Preview, row)
		}
	}
	encodedInspection, err := json.Marshal(inspection)
	if err != nil {
		s.markFatal(work, "CSV_INSPECTION_SERIALIZE_FAILED", "无法保存 CSV 预检结果。", err)
		return
	}
	job.Set("status", "validated")
	job.Set("total_count", inspection.TotalRows)
	job.Set("processed_count", inspection.TotalRows)
	job.Set("success_count", inspection.ValidRows)
	job.Set("failed_count", inspection.InvalidRows)
	job.Set("error_message", fmt.Sprintf("检测编码：%s；页码字段：%s", encodingName, pdfPageField))
	job.Set("inspection_json", string(encodedInspection))
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		s.markFatal(work, "CSV_INSPECTION_FINALIZE_FAILED", "CSV 已预检，但预检结果保存失败。", err)
		return
	}
	logUpload("info", "csv_inspection_completed", map[string]any{
		"request_id":     work.requestID,
		"job_id":         work.id,
		"project_id":     job.GetString("project"),
		"file_name":      job.GetString("original_filename"),
		"encoding":       inspection.Encoding,
		"pdf_page_field": inspection.PDFPageField,
		"total_count":    inspection.TotalRows,
		"valid_count":    inspection.ValidRows,
		"invalid_count":  inspection.InvalidRows,
	})
}

func (s *importService) processCSV(work importWork) {
	jobID := work.id
	job, err := s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		logUpload("error", "csv_job_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     jobID,
			"error":      err.Error(),
		})
		return
	}
	job.Set("status", "processing")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	job.Set("total_count", 0)
	job.Set("processed_count", 0)
	job.Set("success_count", 0)
	job.Set("failed_count", 0)
	if err := s.app.Save(job); err != nil {
		logUpload("error", "csv_job_start_persist_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     jobID,
			"project_id": job.GetString("project"),
			"error":      err.Error(),
		})
		return
	}
	if err := s.clearJobArtifacts(jobID); err != nil {
		s.markFatal(
			work,
			"JOB_RECOVERY_CLEANUP_FAILED",
			"无法清理该作业上次未完成的导入结果。",
			err,
		)
		return
	}

	file, closeFile, err := s.openRecordFile(job, "source_file")
	if err != nil {
		s.markFatal(work, "CSV_FILE_MISSING", "服务器找不到已上传的 CSV 文件。", err)
		return
	}
	defer closeFile()

	decoded, encodingName, err := decodedCSVReader(file)
	if err != nil {
		s.markFatal(work, "CSV_ENCODING_ERROR", "CSV 编码无法识别，请使用 UTF-8 或 GB18030。", err)
		return
	}

	csvReader := csv.NewReader(decoded)
	csvReader.FieldsPerRecord = -1
	csvReader.ReuseRecord = false

	headers, err := csvReader.Read()
	if err != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", csvReadErrorMessage(err), err)
		return
	}
	headers, pdfIndex, headerErr := validateCSVHeaders(headers)
	if headerErr != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", headerErr.Error(), headerErr)
		return
	}

	projectFileID := job.GetString("project_file")
	pdfPageLimit := job.GetInt("pdf_page_limit")
	if !job.GetBool("pdf_snapshot_captured") && job.GetString("inspection_json") != "" {
		s.markFatal(
			work,
			"PDF_SNAPSHOT_MISSING",
			"该 CSV 预检创建于 PDF 快照功能启用前，请重新上传并预检 CSV。",
			errors.New("legacy inspected job has no PDF snapshot"),
		)
		return
	}
	if !job.GetBool("pdf_snapshot_captured") {
		projectFileID, pdfPageLimit = s.primaryPDFSnapshot(job.GetString("project"))
		job.Set("project_file", projectFileID)
		job.Set("pdf_page_limit", pdfPageLimit)
		job.Set("pdf_snapshot_captured", true)
		if err := s.app.Save(job); err != nil {
			s.markFatal(work, "PDF_SNAPSHOT_PERSIST_FAILED", "CSV 导入无法固定当前主 PDF。", err)
			return
		}
	}
	if pdfPageLimit > 0 {
		projectFile, lookupErr := s.app.FindRecordById("project_files", projectFileID)
		if lookupErr != nil || projectFile.GetString("project") != job.GetString("project") || projectFile.GetString("status") != "ready" {
			if lookupErr == nil {
				lookupErr = errors.New("snapshotted PDF no longer belongs to the project or is not ready")
			}
			s.markFatal(work, "PDF_SNAPSHOT_UNAVAILABLE", "CSV 预检使用的 PDF 已不可用，请重新上传并预检 CSV。", lookupErr)
			return
		}
	}

	nextPageNumber := s.nextProjectPageNumber(job.GetString("project"))
	counters := &csvCounters{}
	batch := make([]csvPage, 0, batchSize)

	for {
		values, readErr := csvReader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			line := csvErrorLine(readErr)
			counters.total++
			counters.processed++
			counters.failed++
			s.addJobError(jobID, line, "", "CSV_PARSE_ERROR", csvReadErrorMessage(readErr), "", false)
			continue
		}

		line, _ := csvReader.FieldPos(0)
		counters.total++
		page, validationErr := buildCSVPageWithLimit(headers, values, pdfIndex, line, pdfPageLimit)
		if validationErr != nil {
			counters.processed++
			counters.failed++
			s.addJobError(
				jobID,
				validationErr.line,
				validationErr.column,
				validationErr.code,
				validationErr.message,
				validationErr.rawValue,
				false,
			)
			continue
		}
		batch = append(batch, page)

		if len(batch) >= batchSize {
			nextPageNumber = s.flushCSVBatch(job, batch, nextPageNumber, counters)
			batch = batch[:0]
			s.updateJobProgress(job, counters, encodingName)
		}
	}

	if len(batch) > 0 {
		nextPageNumber = s.flushCSVBatch(job, batch, nextPageNumber, counters)
		_ = nextPageNumber
	}

	status := "completed"
	if counters.failed > 0 {
		status = "completed_with_errors"
	}
	job.Set("status", status)
	job.Set("total_count", counters.total)
	job.Set("processed_count", counters.processed)
	job.Set("success_count", counters.success)
	job.Set("failed_count", counters.failed)
	job.Set("error_code", "")
	job.Set("error_message", fmt.Sprintf("检测编码：%s", encodingName))
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.RunInTransaction(func(txDao core.App) error {
		if _, err := txDao.DB().NewQuery(
			`UPDATE pages
			 SET status = 'pending', updated = strftime('%Y-%m-%d %H:%M:%fZ')
			 WHERE import_job = {:jobID} AND status = 'importing'`,
		).Bind(dbx.Params{"jobID": jobID}).Execute(); err != nil {
			return err
		}
		return txDao.Save(job)
	}); err != nil {
		s.markFatal(work, "JOB_FINALIZE_FAILED", "条目已处理，但作业状态更新失败。", err)
		return
	}
	logUpload("info", "csv_completed", map[string]any{
		"request_id":    work.requestID,
		"kind":          "csv",
		"job_id":        jobID,
		"project_id":    job.GetString("project"),
		"file_name":     job.GetString("original_filename"),
		"file_size":     job.GetInt("file_size"),
		"file_hash":     job.GetString("file_hash"),
		"encoding":      encodingName,
		"total_count":   counters.total,
		"success_count": counters.success,
		"failed_count":  counters.failed,
	})
}

func (s *importService) clearJobArtifacts(jobID string) error {
	return clearJobArtifacts(s.app, jobID)
}

func clearJobArtifacts(dao core.App, jobID string) error {
	return dao.RunInTransaction(func(txDao core.App) error {
		if err := deleteJobPages(txDao, jobID); err != nil {
			return err
		}
		return deleteRecordBatches(txDao, "import_job_errors", fmt.Sprintf("job = %q", jobID))
	})
}

func (s *importService) clearJobPages(jobID string) error {
	return s.app.RunInTransaction(func(txDao core.App) error {
		return deleteJobPages(txDao, jobID)
	})
}

func deleteJobPages(dao core.App, jobID string) error {
	var attemptCount int
	if err := dao.DB().NewQuery(
		`SELECT COUNT(*)
		 FROM proofreading_attempts attempts
		 INNER JOIN pages ON pages.id = attempts.page
		 WHERE pages.import_job = {:jobID}`,
	).Bind(dbx.Params{"jobID": jobID}).Row(&attemptCount); err != nil {
		return err
	}

	filter := fmt.Sprintf("import_job = %q", jobID)
	if err := walkRecordBatches(
		artifactCleanupBatch,
		true,
		func(limit, offset int) ([]*core.Record, error) {
			return dao.FindRecordsByFilter("pages", filter, "id", limit, offset)
		},
		func(pages []*core.Record) error {
			for _, page := range pages {
				if !isDiscardableImportPage(
					page.GetString("status"),
					page.GetString("proofreader"),
					page.GetString("first_proofreader"),
					page.GetString("second_proofreader"),
					attemptCount > 0,
				) {
					return fmt.Errorf("refusing to delete published import page %s during cleanup", page.Id)
				}
			}
			return nil
		},
	); err != nil {
		return err
	}
	return deleteRecordBatches(dao, "pages", filter)
}

func deleteRecordBatches(dao core.App, collection, filter string) error {
	return walkRecordBatches(
		artifactCleanupBatch,
		false,
		func(limit, offset int) ([]*core.Record, error) {
			return dao.FindRecordsByFilter(collection, filter, "id", limit, offset)
		},
		func(records []*core.Record) error {
			for _, record := range records {
				if err := dao.Delete(record); err != nil {
					return err
				}
			}
			return nil
		},
	)
}

func walkRecordBatches(
	batchSize int,
	advanceOffset bool,
	fetch func(limit, offset int) ([]*core.Record, error),
	visit func([]*core.Record) error,
) error {
	if batchSize <= 0 {
		return errors.New("record batch size must be positive")
	}
	offset := 0
	for {
		records, err := fetch(batchSize, offset)
		if err != nil {
			return err
		}
		if len(records) == 0 {
			return nil
		}
		if err := visit(records); err != nil {
			return err
		}
		if len(records) < batchSize {
			return nil
		}
		if advanceOffset {
			offset += len(records)
		}
	}
}

func isDiscardableImportPage(status, proofreader, firstProofreader, secondProofreader string, hasAttempts bool) bool {
	return status == "importing" &&
		proofreader == "" &&
		firstProofreader == "" &&
		secondProofreader == "" &&
		!hasAttempts
}

func decodedCSVReader(reader io.ReadSeeker) (io.Reader, string, error) {
	isUTF8, hasBOM, err := inspectUTF8(reader)
	if err != nil {
		return nil, "", err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, "", err
	}
	if isUTF8 {
		if hasBOM {
			if _, err := reader.Seek(3, io.SeekStart); err != nil {
				return nil, "", err
			}
		}
		return reader, "UTF-8", nil
	}
	return transform.NewReader(reader, simplifiedchinese.GB18030.NewDecoder()), "GB18030", nil
}

func inspectUTF8(reader io.Reader) (valid bool, bom bool, err error) {
	buffer := make([]byte, 64*1024)
	pending := make([]byte, 0, utf8.UTFMax)
	first := true

	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			data := make([]byte, 0, len(pending)+n)
			data = append(data, pending...)
			data = append(data, buffer[:n]...)
			pending = pending[:0]

			if first {
				first = false
				bom = len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf
				if bom {
					data = data[3:]
				}
			}

			for len(data) > 0 {
				if !utf8.FullRune(data) {
					pending = append(pending, data...)
					break
				}
				r, size := utf8.DecodeRune(data)
				if r == utf8.RuneError && size == 1 {
					return false, bom, nil
				}
				data = data[size:]
			}
		}
		if errors.Is(readErr, io.EOF) {
			return len(pending) == 0, bom, nil
		}
		if readErr != nil {
			return false, bom, readErr
		}
	}
}

func validateCSVHeaders(raw []string) ([]string, int, error) {
	headers, pdfIndex, _, err := resolveCSVHeaders(raw)
	return headers, pdfIndex, err
}

var pdfPageHeaderAliases = []string{"PDF页码", "page", "pdf_page", "页码"}

func resolveCSVHeaders(raw []string) ([]string, int, string, error) {
	if len(raw) == 0 {
		return nil, -1, "", errors.New("CSV 缺少表头。")
	}
	headers := make([]string, len(raw))
	seen := map[string]struct{}{}
	aliasIndexes := make([]int, 0, 1)
	for i, value := range raw {
		header := strings.TrimSpace(strings.TrimPrefix(value, "\ufeff"))
		if header == "" {
			return nil, -1, "", fmt.Errorf("第 %d 列表头为空。", i+1)
		}
		if _, exists := seen[header]; exists {
			return nil, -1, "", fmt.Errorf("表头 %q 重复。", header)
		}
		seen[header] = struct{}{}
		headers[i] = header
		for _, alias := range pdfPageHeaderAliases {
			if strings.EqualFold(header, alias) {
				aliasIndexes = append(aliasIndexes, i)
				break
			}
		}
	}
	if len(aliasIndexes) == 0 {
		return nil, -1, "", fmt.Errorf(
			"CSV 缺少页码字段；支持 PDF页码、page、pdf_page 或 页码。检测到的表头：%s。",
			strings.Join(headers, "、"),
		)
	}
	if len(aliasIndexes) > 1 {
		aliases := make([]string, 0, len(aliasIndexes))
		for _, index := range aliasIndexes {
			aliases = append(aliases, headers[index])
		}
		return nil, -1, "", fmt.Errorf("检测到多个页码字段：%s；请只保留一个。", strings.Join(aliases, "、"))
	}
	pdfIndex := aliasIndexes[0]
	return headers, pdfIndex, headers[pdfIndex], nil
}

type rowValidationError struct {
	line     int
	column   string
	code     string
	message  string
	rawValue string
}

func buildCSVPage(headers, values []string, pdfIndex, line int) (csvPage, *rowValidationError) {
	if len(values) != len(headers) {
		return csvPage{}, &rowValidationError{
			line:    line,
			code:    "COLUMN_COUNT_MISMATCH",
			message: fmt.Sprintf("本行有 %d 列，表头有 %d 列。", len(values), len(headers)),
		}
	}

	rawPDFPage := strings.TrimSpace(values[pdfIndex])
	pdfPage, err := strconv.Atoi(rawPDFPage)
	if err != nil || pdfPage <= 0 {
		return csvPage{}, &rowValidationError{
			line:     line,
			column:   "PDF页码",
			code:     "INVALID_PDF_PAGE",
			message:  "PDF页码必须是正整数。",
			rawValue: truncateText(rawPDFPage, 200),
		}
	}

	structured := make(map[string]string, len(headers)-1)
	parts := make([]string, 0, len(headers)-1)
	orderedHeaders := make([]string, 0, len(headers)-1)
	for index, header := range headers {
		if index == pdfIndex {
			continue
		}
		value := strings.TrimSpace(values[index])
		structured[header] = value
		orderedHeaders = append(orderedHeaders, header)
		if value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) == 0 {
		return csvPage{}, &rowValidationError{
			line:    line,
			code:    "EMPTY_CONTENT",
			message: "去掉 PDF页码 后内容不能为空。",
		}
	}

	headersJSON, _ := json.Marshal(orderedHeaders)
	rowJSON, err := json.Marshal(structured)
	if err != nil {
		return csvPage{}, &rowValidationError{
			line:    line,
			code:    "ROW_SERIALIZE_ERROR",
			message: "无法序列化本行内容。",
		}
	}
	return csvPage{
		line:        line,
		pdfPage:     pdfPage,
		rowJSON:     string(rowJSON),
		headersJSON: string(headersJSON),
		entryText:   strings.Join(parts, " "),
	}, nil
}

func buildCSVPageWithLimit(headers, values []string, pdfIndex, line, maxPDFPage int) (csvPage, *rowValidationError) {
	page, validationErr := buildCSVPage(headers, values, pdfIndex, line)
	if validationErr != nil {
		return csvPage{}, validationErr
	}
	if maxPDFPage > 0 && page.pdfPage > maxPDFPage {
		return csvPage{}, &rowValidationError{
			line:     line,
			column:   headers[pdfIndex],
			code:     "PDF_PAGE_OUT_OF_RANGE",
			message:  fmt.Sprintf("PDF页码超出当前主 PDF 的页数上限（%d 页）。", maxPDFPage),
			rawValue: strconv.Itoa(page.pdfPage),
		}
	}
	return page, nil
}

func (s *importService) primaryPDFSnapshot(projectID string) (string, int) {
	records, err := s.app.FindRecordsByFilter(
		"project_files",
		fmt.Sprintf(`project = %q && status = "ready" && is_primary = true`, projectID),
		"-created",
		1,
		0,
	)
	if err != nil {
		logUpload("error", "primary_pdf_lookup_failed", map[string]any{
			"project_id": projectID,
			"error":      err.Error(),
		})
		return "", 0
	}
	if len(records) == 0 {
		return "", 0
	}
	return records[0].Id, records[0].GetInt("page_count")
}

func (s *importService) nextProjectPageNumber(projectID string) int {
	records, err := s.app.FindRecordsByFilter(
		"pages",
		fmt.Sprintf("project = %q", projectID),
		"-page_number",
		1,
		0,
	)
	if err != nil || len(records) == 0 {
		return 1
	}
	return records[0].GetInt("page_number") + 1
}

func (s *importService) flushCSVBatch(
	job *core.Record,
	rows []csvPage,
	nextPageNumber int,
	counters *csvCounters,
) int {
	projectID := job.GetString("project")
	projectFileID := job.GetString("project_file")
	err := s.app.RunInTransaction(func(txDao core.App) error {
		for index, row := range rows {
			if err := savePage(txDao, job.Id, projectID, projectFileID, nextPageNumber+index, row); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		counters.processed += len(rows)
		counters.success += len(rows)
		return nextPageNumber + len(rows)
	}
	logUpload("warn", "csv_batch_transaction_failed", map[string]any{
		"kind":       "csv",
		"job_id":     job.Id,
		"project_id": projectID,
		"batch_size": len(rows),
		"error":      err.Error(),
	})

	// Fall back to individual writes so one unexpected database error doesn't
	// prevent later valid rows from importing.
	for _, row := range rows {
		if err := savePage(s.app, job.Id, projectID, projectFileID, nextPageNumber, row); err != nil {
			counters.failed++
			s.addJobError(
				job.Id,
				row.line,
				"",
				"DATABASE_WRITE_ERROR",
				"该行通过格式校验，但写入数据库失败。",
				truncateText(err.Error(), 500),
				true,
			)
		} else {
			counters.success++
			nextPageNumber++
		}
		counters.processed++
	}
	return nextPageNumber
}

func savePage(dao core.App, jobID, projectID, projectFileID string, pageNumber int, row csvPage) error {
	collection, err := dao.FindCollectionByNameOrId("pages")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("project", projectID)
	record.Set("import_job", jobID)
	record.Set("project_file", projectFileID)
	record.Set("page_number", pageNumber)
	record.Set("pdf_page", row.pdfPage)
	record.Set("ocr_row_json", row.rowJSON)
	record.Set("row_headers_json", row.headersJSON)
	record.Set("ocr_text", row.entryText)
	record.Set("proofread_round", 1)
	record.Set("mismatch_count", 0)
	record.Set("status", "importing")
	return dao.Save(record)
}

func (s *importService) addJobError(
	jobID string,
	rowNumber int,
	columnName string,
	code string,
	message string,
	rawValue string,
	retryable bool,
) {
	collection, err := s.app.FindCollectionByNameOrId("import_job_errors")
	if err != nil {
		logUpload("error", "csv_error_collection_lookup_failed", map[string]any{
			"kind":       "csv",
			"job_id":     jobID,
			"row_number": rowNumber,
			"error_code": code,
			"error":      err.Error(),
		})
		return
	}
	record := core.NewRecord(collection)
	record.Set("job", jobID)
	record.Set("row_number", rowNumber)
	record.Set("column_name", columnName)
	record.Set("error_code", code)
	record.Set("message", message)
	record.Set("raw_value", truncateText(rawValue, 1000))
	record.Set("retryable", retryable)
	if err := s.app.Save(record); err != nil {
		logUpload("error", "csv_error_persist_failed", map[string]any{
			"kind":       "csv",
			"job_id":     jobID,
			"row_number": rowNumber,
			"error_code": code,
			"error":      err.Error(),
		})
	}
}

func (s *importService) updateJobProgress(job *core.Record, counters *csvCounters, encodingName string) {
	job.Set("processed_count", counters.processed)
	job.Set("success_count", counters.success)
	job.Set("failed_count", counters.failed)
	job.Set("error_message", fmt.Sprintf("检测编码：%s", encodingName))
	if err := s.app.Save(job); err != nil {
		logUpload("error", "csv_progress_persist_failed", map[string]any{
			"kind":            "csv",
			"job_id":          job.Id,
			"project_id":      job.GetString("project"),
			"processed_count": counters.processed,
			"success_count":   counters.success,
			"failed_count":    counters.failed,
			"error":           err.Error(),
		})
	}
}

func csvErrorLine(err error) int {
	var parseError *csv.ParseError
	if errors.As(err, &parseError) {
		return parseError.Line
	}
	return 0
}

func csvReadErrorMessage(err error) string {
	var parseError *csv.ParseError
	if errors.As(err, &parseError) {
		return fmt.Sprintf("第 %d 行、第 %d 列 CSV 格式错误：%s。", parseError.Line, parseError.Column, parseError.Err)
	}
	return "CSV 格式错误。"
}

func truncateText(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes]) + "…"
}
