package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"fangji/backend/reviewbundle"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/types"
)

// #183 Review Bundle 导入：幂等、自然键与部分失败行为。
//
// 与 #227 的分工是刻意的：`reviewbundle.ValidateZip` 只验不写，`Load` 复用它的解包与
// 校验，所以「通过校验」与「能被解析」不可能各自漂移。本文件只做它刻意没做的那一半——
// 落库，并给出三种确定行为：
//
//  1. **幂等**：同一 (project, bundle_id) 且**未失败**的作业 → 直接返回原作业，不新建、
//     不重导。口径与 CSV 侧刻意一致（import_service.go 的同型去重同样带 `status != "failed"`）：
//     failed 允许重试，否则一个因瞬时原因失败的批次会因为 bundle_id 是来源侧身份、
//     上游不能随意改而永久无法经由 API 重试。重放安全性不受影响——真重试时未写完的条目
//     仍由条目级自然键挡住。同一条目的重复写入同样由唯一索引兜住，跳过而不是覆盖。
//  2. **版本变化**：同 entry_id、新 source_version → 自然键不同 → 新条目，旧条目留在库里
//     可追溯。这条规则不写在业务代码里，它是 (…, source_version, source_entry_id)
//     唯一索引的自然结果。
//  3. **部分失败**：契约允许但本系统的条目模型不能容纳的行（全空、非文本值）按行报错，
//     合法行继续，终态 completed_with_errors。
//
// 恢复语义：作业重启后由 recoverPendingWork 重新入队，重跑时已经写进去的条目会被同一把
// 唯一索引挡住，所以不需要额外的游标表——自然键本身就是游标。代价是重跑会重新解包与
// 重新校验一遍（有界的，20MB 上限），换来的是「恢复」与「重放」共用同一条代码路径。

const bundleImportField = "bundle"

func (s *importService) registerBundleImports() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/imports/bundle",
			s.uploadBundle,
		).Bind(apis.BodyLimit(maxBundleUploadBytes+1<<20), apis.RequireAuth("users"))
		return e.Next()
	})
}

// bundlePage 是一条待落库的条目。四条来源键在写入时构成自然键的一部分，
// 所以它们必须随行一起带下去，不能只留在作业上——版本变化产生的正是「同 entry_id、
// 不同 source_version」的第二条记录。
type bundlePage struct {
	line          int
	entryID       string
	sourceSystem  string
	sourceID      string
	sourceVersion string
	fields        []reviewbundle.Field
	// ignored 是条目里带了、但不在 requested_fields 里的键：不落库，但要能被上报。
	ignored     []string
	pdfPage     int
	rowJSON     string
	headersJSON string
	entryText   string
}

// isPDFPageHeader 与 CSV 的 resolveCSVHeaders 共用同一份别名表：
// 「哪一列是页码」只该有一处定义，否则 bundle 与 CSV 两条路会各自漂移。
func isPDFPageHeader(name string) bool {
	for _, alias := range pdfPageHeaderAliases {
		if strings.EqualFold(strings.TrimSpace(name), alias) {
			return true
		}
	}
	return false
}

// bundlePageNumber 从页码列的值里取出页号。
//
// 契约只要求 requested_fields 里的键**存在**（checkInboundFields 不查值的类型），
// 所以 `{"PDF页码": 3}` 是能过校验的合法包，而 encoding/json 会把它解成 float64。
// 数字与数字字符串都接受；解析不出、非正整数、非数字形状一律返回 false，
// 由调用方按「这一行没有页码」处理——与 CSV 侧「解析不出来就当作没有页码」同口径。
func bundlePageNumber(value any) (int, bool) {
	switch typed := value.(type) {
	case string:
		number, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil || number <= 0 {
			return 0, false
		}
		return number, true
	case float64:
		// 只接受整数值：上游写 `3` 与 `3.0` 同义，`3.5` 不是页号。
		// 上界防 int 溢出——超出 int32 的值按「没有页码」处理，与 Atoi 在超范围
		// 数字字符串上的行为一致。
		if typed != math.Trunc(typed) || typed <= 0 || typed > math.MaxInt32 {
			return 0, false
		}
		return int(typed), true
	default:
		return 0, false
	}
}

// rowValidationError 复用 CSV 导入的错误形状，让 import_job_errors 的四个字段
// （row_number / column_name / error_code / raw_value）在两条导入路径上同义。
type bundleRowError struct {
	column    string
	code      string
	message   string
	rawValue  string
	retryable bool
}

// buildBundlePage 把一条已通过契约校验的条目变成可落库的行。
//
// 这里做的判断**不在契约校验的范围里**，所以它不会与 ValidateZip 重复：
// 契约只保证「请求字段都在」，不保证「这些值能成为本系统的一个条目」。
//   - 全空：与 CSV 导入的 EMPTY_CONTENT 同义，避免在库里留下无内容的条目；
//   - 非文本值：契约允许任意 JSON 值，而 W 的条目模型是文本列。宁可逐条报出来，
//     也不要静默 JSON.stringify——那会把「上游给了一个对象」变成一条看起来正常的字符串。
func buildBundlePage(bundle reviewbundle.Bundle, entry reviewbundle.Entry, maxPDFPage int) (bundlePage, *bundleRowError) {
	byName := make(map[string]reviewbundle.Field, len(entry.Fields))
	ignored := []string{}
	requested := make(map[string]bool, len(bundle.RequestedFields))
	for _, name := range bundle.RequestedFields {
		requested[name] = true
	}
	for _, field := range entry.Fields {
		if !requested[field.Name] {
			// 契约只要求 fields **包含** requested_fields（下界），所以多给的键不算违约；
			// 但它们不在「希望校对的字段」里，落库就会变成整个项目的一列、并随任务下发给
			// 校对员（column_roles 的 headersForProject 会把各页表头按页序 union）。
			// 因此不落库，只计数上报，不静默。
			ignored = append(ignored, field.Name)
			continue
		}
		if _, exists := byName[field.Name]; !exists {
			byName[field.Name] = field
		}
	}

	fields := make([]reviewbundle.Field, 0, len(bundle.RequestedFields))
	headers := make([]string, 0, len(bundle.RequestedFields))
	parts := make([]string, 0, len(bundle.RequestedFields))
	pdfPage := 0

	// 列的顺序取 requested_fields，而不是条目自己的键顺序：同一包内条目键序不一致时，
	// headersForProject 的按页 union 会变成一个取决于哪一页先到的交错顺序。
	for _, name := range bundle.RequestedFields {
		field, ok := byName[name]
		if !ok {
			continue // 校验器保证每个 requested 字段都在；这里是防御性跳过
		}
		if isPDFPageHeader(field.Name) {
			// 与 CSV 导入一致：页码列不进表头，它落到 pdf_page。
			//
			// 这一列**先于文本断言分流**，因为它本来就不是文本列：pdf_page 是整数列，
			// 页码永远不会进 row_headers_json / ocr_row_json，对它做 FIELD_VALUE_NOT_TEXT
			// 没有收益，只会让「上游把页码写成 JSON 数字」这种**过了契约校验的合法包**
			// 整行被拒——而 `3` 比 `"三"` 更好解析。数字与数字字符串都接受；
			// 其余形状按「这一行没有页码」处理，不是整行失败（契约里页码不是必填字段）。
			if number, parsed := bundlePageNumber(field.Value); parsed {
				pdfPage = number
			}
			continue
		}
		value, ok := field.Value.(string)
		if !ok {
			return bundlePage{}, &bundleRowError{
				column:   field.Name,
				code:     "FIELD_VALUE_NOT_TEXT",
				message:  fmt.Sprintf("字段「%s」不是文本值，本系统的条目列只能容纳文本。", field.Name),
				rawValue: truncateText(fmt.Sprint(field.Value), 200),
			}
		}
		trimmed := strings.TrimSpace(value)
		fields = append(fields, reviewbundle.Field{Name: field.Name, Value: trimmed})
		headers = append(headers, field.Name)
		if trimmed != "" {
			parts = append(parts, trimmed)
		}
	}

	if len(parts) == 0 {
		return bundlePage{}, &bundleRowError{
			code:    "EMPTY_CONTENT",
			message: "去掉页码后内容不能为空。",
		}
	}
	if maxPDFPage > 0 && pdfPage > maxPDFPage {
		return bundlePage{}, &bundleRowError{
			column:   "PDF页码",
			code:     "PDF_PAGE_OUT_OF_RANGE",
			message:  fmt.Sprintf("PDF页码超出当前主 PDF 的页数上限（%d 页）。", maxPDFPage),
			rawValue: strconv.Itoa(pdfPage),
		}
	}

	headersJSON, err := json.Marshal(headers)
	if err != nil {
		return bundlePage{}, &bundleRowError{code: "ROW_SERIALIZE_ERROR", message: "无法序列化本行的表头。"}
	}
	rowJSON, err := marshalOrderedFields(fields)
	if err != nil {
		return bundlePage{}, &bundleRowError{code: "ROW_SERIALIZE_ERROR", message: "无法序列化本行内容。"}
	}
	return bundlePage{
		line:          entry.Line,
		entryID:       entry.EntryID,
		sourceSystem:  bundle.SourceSystem,
		sourceID:      bundle.SourceID,
		sourceVersion: bundle.SourceVersion,
		fields:        fields,
		ignored:       ignored,
		pdfPage:       pdfPage,
		rowJSON:       rowJSON,
		headersJSON:   string(headersJSON),
		entryText:     strings.Join(parts, " "),
	}, nil
}

// marshalOrderedFields 手写序列化而不是 json.Marshal(map)：Go 的 map 会按键排序，
// 而这一行的键顺序就是导入后的列顺序，排过序的表头与原书列序不符。
func marshalOrderedFields(fields []reviewbundle.Field) (string, error) {
	var builder strings.Builder
	builder.WriteByte('{')
	for index, field := range fields {
		if index > 0 {
			builder.WriteByte(',')
		}
		name, err := json.Marshal(field.Name)
		if err != nil {
			return "", err
		}
		value, err := json.Marshal(field.Value)
		if err != nil {
			return "", err
		}
		builder.Write(name)
		builder.WriteByte(':')
		builder.Write(value)
	}
	builder.WriteByte('}')
	return builder.String(), nil
}

// uploadBundle 接一个 zip，校验后建作业。校验不通过时**不写任何数据**，
// 并把校验报告原样返回（与 /api/fangji/bundles/validate 同一份形状）。
func (s *importService) uploadBundle(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	projectID := c.Request.PathValue("projectId")
	// 与只读入口 bundle_validate.go、PDF 写入口 pdf_uploads.go 一致：还没改初始密码的账号
	// 不该往项目里写条目。（CSV 入口漏了这条，不在本 PR 的口径里 —— 见 PR 正文。）
	if c.Auth != nil && c.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先登录并完成初始密码修改。", nil)
	}
	auth, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}

	uploaded, header, err := c.Request.FormFile(bundleImportField)
	if err != nil {
		return apis.NewBadRequestError("请上传字段 bundle 中的压缩包。", nil)
	}
	defer uploaded.Close()
	if header.Size > maxBundleUploadBytes {
		return apis.NewBadRequestError("压缩包超过 20MB，已拒绝，未写入任何数据。", nil)
	}
	data, err := io.ReadAll(io.LimitReader(uploaded, maxBundleUploadBytes+1))
	if err != nil {
		return apis.NewBadRequestError("压缩包读取失败，未写入任何数据。", nil)
	}
	if len(data) > maxBundleUploadBytes {
		return apis.NewBadRequestError("压缩包超过 20MB，已拒绝，未写入任何数据。", nil)
	}

	bundle, report, err := reviewbundle.Load(data)
	if err != nil {
		return apis.NewBadRequestError("压缩包无法读取，未写入任何数据。", nil)
	}
	if !report.OK {
		// 422 而不是 400：包本身是合法上传，是内容不符合契约。响应体就是校验报告，
		// 前端与 /bundles/validate 用同一套渲染。
		return c.JSON(http.StatusUnprocessableEntity, report)
	}

	// rights_ref 是契约要求的来源登记 logical_id（校验器只查格式，存在性留给我们）。
	// 判据直接复用 CSV 那条（import_service.go 的 importSourceLink）：找得到就关联，
	// 找不到就拒绝这一次导入，不静默标成 unknown —— 与
	// docs/plans/2026-09-29-source-registry.md 的既有口径一致。
	// bundle 的 rights_ref 是必填的，所以这里不存在「留空 ⇒ unknown」那一支。
	sourceID, sourceLink, err := s.importSourceLink(bundle.RightsRef)
	if err != nil {
		return apis.NewBadRequestError(
			fmt.Sprintf("压缩包声明的 rights_ref「%s」不在来源登记里。请先在来源登记建好这条 logical_id 再导入。", bundle.RightsRef),
			nil)
	}

	// 幂等：同一 bundle 已经有**未失败**的作业（含正在跑的）就直接把它还给调用方。
	// failed 刻意不在短路范围内：bundle_id 是来源侧身份，上游不能随意改，
	// 把 failed 也短路掉等于让一个瞬时失败的批次永久无法经由 API 重试。
	existing, err := s.findJobByBundle(projectID, bundle.BundleID)
	if err != nil {
		return apis.NewBadRequestError("读取已有导入作业失败。", err)
	}
	if existing != nil {
		logUpload("info", "bundle_replay_short_circuit", map[string]any{
			"request_id": requestID,
			"project_id": projectID,
			"bundle_id":  bundle.BundleID,
			"job_id":     existing.Id,
			"status":     existing.GetString("status"),
		})
		return c.JSON(http.StatusOK, map[string]any{"status": "already_imported", "job": existing})
	}

	collection, err := s.app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		return apis.NewBadRequestError("导入作业存储尚未初始化。", err)
	}
	sum := sha256.Sum256(data)
	record := core.NewRecord(collection)
	record.Set("project", projectID)
	record.Set("created_by", auth.Id)
	record.Set("mode", "bundle")
	record.Set("status", "queued")
	record.Set("original_filename", bundleFileName(header.Filename, bundle.BundleID))
	record.Set("file_hash", hex.EncodeToString(sum[:]))
	record.Set("file_size", len(data))
	record.Set("total_count", len(bundle.Entries))
	record.Set("processed_count", 0)
	record.Set("success_count", 0)
	record.Set("failed_count", 0)
	record.Set("bundle_id", bundle.BundleID)
	record.Set("bundle_schema_version", bundle.SchemaVersion)
	record.Set("source", sourceID)
	record.Set("source_link", sourceLink)
	file, err := filesystem.NewFileFromBytes(data, record.GetString("original_filename"))
	if err != nil {
		return apis.NewBadRequestError("保存压缩包失败，未写入任何数据。", err)
	}
	record.Set("source_file", file)
	if err := s.app.Save(record); err != nil {
		// idx_import_jobs_bundle 是部分唯一索引（WHERE status != 'failed'），并发上传同一批时
		// 后来者会在这里撞上。重查一次确认「现在确实有同键作业」再按重放返回，查不到才如实
		// 报错——不这么分，一条真实的写入失败会被当成重复而静默吞掉（与条目级同一取舍）。
		if again, lookupErr := s.findJobByBundle(projectID, bundle.BundleID); lookupErr == nil && again != nil {
			return c.JSON(http.StatusOK, map[string]any{"status": "already_imported", "job": again})
		}
		return apis.NewBadRequestError("创建导入作业失败，未写入任何数据。", err)
	}
	s.enqueue(importWork{kind: "bundle", id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

// findJobByBundle 是作业级幂等的唯一查询入口：查与写后重查共用它，
// 所以「什么算同一次重放」只有一处定义。
func (s *importService) findJobByBundle(projectID, bundleID string) (*core.Record, error) {
	// bundle_id != "" 这一条不是多余的：idx_import_jobs_bundle 是**部分**唯一索引
	// （WHERE status != 'failed' AND bundle_id != ''，后者是为了让 CSV/OCR 那些
	// bundle_id 为空串的作业不受约束），而 SQLite 只有在查询里显式写出这些谓词时
	// 才会选中它。它在这里恒真：本函数只在 bundle 路径上被调用。
	records, err := s.app.FindRecordsByFilter(
		"import_jobs",
		`project = {:project} && bundle_id != "" && bundle_id = {:bundle} && status != "failed"`,
		"-created",
		1,
		0,
		dbx.Params{"project": projectID, "bundle": bundleID},
	)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, nil
	}
	return records[0], nil
}

// bundleFileName 保留上传者给的文件名（作业列表里要能认出来），但去掉路径成分，
// 并在缺失时按 bundle_id 造一个——original_filename 是必填列。
func bundleFileName(raw, bundleID string) string {
	name := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if index := strings.LastIndexByte(name, '/'); index >= 0 {
		name = name[index+1:]
	}
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name))
	if name == "" {
		name = truncateText(bundleID, 200) + ".zip"
	}
	return truncateText(name, 200)
}

func (s *importService) processBundle(work importWork) {
	jobID := work.id
	job, err := s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		logUpload("error", "bundle_job_lookup_failed", map[string]any{
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
	job.Set("processed_count", 0)
	job.Set("success_count", 0)
	job.Set("failed_count", 0)
	if err := s.app.Save(job); err != nil {
		logUpload("error", "bundle_job_start_persist_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     jobID,
			"error":      err.Error(),
		})
		return
	}
	// 刻意**不**清理本作业已有的条目：重跑（含恢复）要靠自然键跳过已写入的行，
	// 删掉它们等于把「恢复」变成「从头再来」，而后者会丢掉与旧版本并存的历史。

	file, closeFile, err := s.openRecordFile(job, "source_file")
	if err != nil {
		s.markFatal(work, "BUNDLE_FILE_MISSING", "服务器找不到已上传的压缩包。", err)
		return
	}
	defer closeFile()
	data, err := io.ReadAll(file)
	if err != nil {
		s.markFatal(work, "BUNDLE_FILE_UNREADABLE", "服务器无法读取已上传的压缩包。", err)
		return
	}
	bundle, report, err := reviewbundle.Load(data)
	if err != nil {
		s.markFatal(work, "BUNDLE_UNREADABLE", "已上传的压缩包无法读取。", err)
		return
	}
	if !report.OK {
		s.markFatal(work, "BUNDLE_INVALID", truncateText(reportMessage(report), 500), nil)
		return
	}

	projectID := job.GetString("project")
	projectFileID, pdfPageLimit := s.primaryPDFSnapshot(projectID)
	job.Set("project_file", projectFileID)

	counters := bundleCounters{total: len(bundle.Entries)}
	nextPageNumber := s.nextProjectPageNumber(projectID)
	batch := make([]bundlePage, 0, batchSize)
	for _, entry := range bundle.Entries {
		page, rowErr := buildBundlePage(bundle, entry, pdfPageLimit)
		if rowErr != nil {
			counters.processed++
			counters.failed++
			s.addJobError(jobID, entry.Line, rowErr.column, rowErr.code, rowErr.message, rowErr.rawValue, rowErr.retryable)
			continue
		}
		batch = append(batch, page)
		if len(batch) >= batchSize {
			nextPageNumber = s.flushBundleBatch(job, batch, nextPageNumber, &counters)
			batch = batch[:0]
			s.updateBundleProgress(job, &counters)
		}
	}
	if len(batch) > 0 {
		s.flushBundleBatch(job, batch, nextPageNumber, &counters)
	}

	status := "completed"
	if counters.failed > 0 {
		status = "completed_with_errors"
	}
	if counters.success == 0 && counters.failed > 0 {
		status = "failed"
	}
	job.Set("status", status)
	job.Set("total_count", counters.total)
	job.Set("processed_count", counters.processed)
	job.Set("success_count", counters.success)
	job.Set("failed_count", counters.failed)
	// notes 只在真有事发生时才有内容：无条件写一句「已跳过 0 条重复条目」会让一次
	// 全新的成功导入也挂上一条读起来像错误的文案。
	notes := []string{}
	if counters.skipped > 0 {
		notes = append(notes, fmt.Sprintf("已跳过 %d 条重复条目（同一自然键在前一次导入里已存在）。", counters.skipped))
	}
	if len(counters.ignoredFields) > 0 {
		notes = append(notes, fmt.Sprintf("已忽略 %d 个未请求字段：%s。", len(counters.ignoredFields), strings.Join(counters.ignoredFields, "、")))
	}
	job.Set("error_code", "")
	job.Set("error_message", strings.Join(notes, ""))
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
		// finalize 失败会把已写入的条目留在 status='importing'（那是导入中的暂存态，
		// 对用户不可见也不会进任何队列）。这些僵尸页现在依赖「failed 可重试」被清掉：
		// 调用方重新上传同一个包时，未失败作业的短路不会命中（这条是 failed），于是
		// 走一条新作业，而新作业里同键条目的写入会被条目级唯一索引挡住——僵尸页不会
		// 因此消失。清理它属于运维动作，见本文件头部「failed 可重试」那段口径；
		// 这里先如实记下，不让它成为一条没人知道的隐含性质。
		s.markFatal(work, "JOB_FINALIZE_FAILED", "条目已处理，但作业状态更新失败。", err)
		return
	}
	logUpload("info", "bundle_completed", map[string]any{
		"request_id":  work.requestID,
		"kind":        "bundle",
		"job_id":      jobID,
		"project_id":  projectID,
		"bundle_id":   job.GetString("bundle_id"),
		"total_count": counters.total,
		"success":     counters.success,
		"skipped":     counters.skipped,
		"failed":      counters.failed,
		"ignored":     len(counters.ignoredFields),
		"status":      status,
	})
}

type bundleCounters struct {
	total     int
	processed int
	success   int
	skipped   int
	failed    int
	// ignoredFields 是本次导入里出现过的、但不在 requested_fields 里的键名（去重、有序）。
	// 它们不落库，所以必须有人能看见——否则「上游多给了一列」这件事在作业上完全无痕。
	ignoredFields []string
}

func (c *bundleCounters) recordIgnored(pages []bundlePage) {
	for _, page := range pages {
		for _, name := range page.ignored {
			if !containsStr(c.ignoredFields, name) {
				c.ignoredFields = append(c.ignoredFields, name)
			}
		}
	}
}

// flushBundleBatch 逐条「不存在才写」。整批走一个事务，失败后退回逐条写——
// 与 CSV 导入同一取舍：一条意外的数据库错误不该让后面的合法条目全部落不下。
func (s *importService) flushBundleBatch(
	job *core.Record,
	pages []bundlePage,
	nextPageNumber int,
	counters *bundleCounters,
) int {
	projectID := job.GetString("project")
	projectFileID := job.GetString("project_file")
	number := nextPageNumber
	// skipped 用批次局部变量累计：直接在闭包里 ++ 会在事务回退后重复计数
	// （number 有同样的风险，只是它只造成页码空洞、无害）。
	skippedInBatch := 0
	err := s.app.RunInTransaction(func(txDao core.App) error {
		skippedInBatch = 0
		for _, page := range pages {
			inserted, err := writeBundlePage(txDao, job.Id, projectID, projectFileID, number, page)
			if err != nil {
				return err
			}
			if inserted {
				number++
			} else {
				skippedInBatch++
			}
		}
		return nil
	})
	if err == nil {
		counters.success += len(pages)
		counters.processed += len(pages)
		counters.skipped += skippedInBatch
		counters.recordIgnored(pages)
		return number
	}

	logUpload("warn", "bundle_batch_transaction_failed", map[string]any{
		"kind":       "bundle",
		"job_id":     job.Id,
		"project_id": projectID,
		"batch_size": len(pages),
		"error":      err.Error(),
	})
	for _, page := range pages {
		inserted, writeErr := writeBundlePage(s.app, job.Id, projectID, projectFileID, number, page)
		counters.processed++
		counters.recordIgnored([]bundlePage{page})
		if writeErr != nil {
			counters.failed++
			s.addJobError(job.Id, page.line, "", "DATABASE_WRITE_ERROR",
				"该条通过格式校验，但写入数据库失败。", truncateText(writeErr.Error(), 500), true)
			continue
		}
		// success 只与「这一条有没有写错」有关，所以它在错误分支之外只出现一次——
		// 重放（!inserted）与新建同口径：success 是「非失败已处理」，skipped 也算。
		// 与事务成功路径的 `+= len(pages)` 同义。收成一处是为了让这两条路径不可能
		// 再各自漂移（正常单线程导入走不到这里，CI 的套件覆盖不到回退分支）。
		counters.success++
		if !inserted {
			counters.skipped++
			continue
		}
		number++
	}
	return number
}

// writeBundlePage 返回 (是否新建, 错误)。已经存在同键条目时返回 (false, nil)——
// 那是重放或恢复，不是失败，所以既不新建也不覆盖。
func writeBundlePage(dao core.App, jobID, projectID, projectFileID string, pageNumber int, page bundlePage) (bool, error) {
	existing, err := findPageBySourceKey(dao, projectID, page)
	if err != nil {
		return false, err
	}
	if len(existing) > 0 {
		return false, nil
	}
	if err := insertBundlePage(dao, jobID, projectID, projectFileID, pageNumber, page); err != nil {
		// 并发导入同一批时，两边都可能先查后写：唯一索引会挡住后来者。
		// 重新查一次确认「现在确实有同键条目」，是就按重放处理，不是就如实报错——
		// 不这么分，一条真实的写入失败会被当成重复而静默吞掉。
		again, lookupErr := findPageBySourceKey(dao, projectID, page)
		if lookupErr == nil && len(again) > 0 {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func findPageBySourceKey(dao core.App, projectID string, page bundlePage) ([]*core.Record, error) {
	// source_entry_id != "" 这一条不是多余的：idx_pages_source_entry 是**部分**索引
	// （WHERE source_entry_id != ''，为了让没有来源键的存量行不受唯一约束），
	// 而 SQLite 只有在查询里显式写出这个谓词时才会选中它——不写就退化成按 project 扫全项目。
	// 它在这里恒真：要查的键本身就非空。
	return dao.FindRecordsByFilter(
		"pages",
		`project = {:project} && source_entry_id != "" && source_system = {:system} && source_id = {:source} && source_version = {:version} && source_entry_id = {:entry}`,
		"id",
		1,
		0,
		dbx.Params{
			"project": projectID,
			"system":  page.sourceSystem,
			"source":  page.sourceID,
			"version": page.sourceVersion,
			"entry":   page.entryID,
		},
	)
}

func insertBundlePage(dao core.App, jobID, projectID, projectFileID string, pageNumber int, page bundlePage) error {
	collection, err := dao.FindCollectionByNameOrId("pages")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("project", projectID)
	record.Set("import_job", jobID)
	if projectFileID != "" {
		record.Set("project_file", projectFileID)
	}
	record.Set("page_number", pageNumber)
	if page.pdfPage > 0 {
		record.Set("pdf_page", page.pdfPage)
	}
	record.Set("source_system", page.sourceSystem)
	record.Set("source_id", page.sourceID)
	record.Set("source_version", page.sourceVersion)
	record.Set("source_entry_id", page.entryID)
	record.Set("ocr_row_json", page.rowJSON)
	record.Set("row_headers_json", page.headersJSON)
	record.Set("ocr_text", page.entryText)
	record.Set("proofread_round", 1)
	record.Set("mismatch_count", 0)
	record.Set("status", "importing")
	return dao.Save(record)
}

func (s *importService) updateBundleProgress(job *core.Record, counters *bundleCounters) {
	job.Set("processed_count", counters.processed)
	job.Set("success_count", counters.success)
	job.Set("failed_count", counters.failed)
	if err := s.app.Save(job); err != nil {
		logUpload("error", "bundle_progress_persist_failed", map[string]any{
			"kind":            "bundle",
			"job_id":          job.Id,
			"project_id":      job.GetString("project"),
			"processed_count": counters.processed,
			"error":           err.Error(),
		})
	}
}

// reportMessage 把校验报告压成一句话给作业列表看。逐条诊断仍能从校验接口拿到，
// 这里只需要让人一眼知道「包为什么没进来」。
func reportMessage(report reviewbundle.Report) string {
	if len(report.Errors) == 0 {
		return "压缩包未通过校验。"
	}
	return fmt.Sprintf("压缩包未通过校验（%d 项）：%s", len(report.Errors), report.Errors[0].Message)
}
