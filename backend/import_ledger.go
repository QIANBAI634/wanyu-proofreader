package main

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// registerImportLedger 挂载批次台账只读端点，回答 #317 A1.2 的「行数 / 来源覆盖 / 未知来源计数」。
func (s *importService) registerImportLedger() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET(
			"/api/fangji/projects/{projectId}/import-ledger",
			s.projectImportLedger,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// projectImportLedger 列出本项目的导入批次（import_jobs），并按来源聚合出
// 行数 / 来源覆盖 / 未知来源计数三个数，供管理端对账。
//
// 入册量（imported_rows / 来源覆盖 / 未知来源）一律从 pages 表取「实际创建且已
// 交付的条目」（排除 status=importing 的暂存页），而不是 import_jobs.success_count：
// bundle 复用自然键时会把 skipped 条目也计为 success（成功处理的旧契约），但并未
// 创建新页面，直接累加会重复计入库量。来源 join 用 LEFT JOIN，让没有 import_job
// 或没有来源登记的合法条目如实归入未知桶，而不是被 JOIN 丢掉。输入行数（total_rows）
// 保留 import_jobs.total_count 的「输入」语义。
func (s *importService) projectImportLedger(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}

	params := dbx.Params{"project": projectID}

	// 批次列表：LEFT JOIN sources 拿到来源的 logical_id / title，并附每批实际入库条数
	// （已交付 pages 计数）与跳过条数。source_link 为空的历史批次归一为 unknown。
	type batchRow struct {
		ID               string `db:"id"`
		Created          string `db:"created"`
		FinishedAt       string `db:"finished_at"`
		Status           string `db:"status"`
		Mode             string `db:"mode"`
		OriginalFilename string `db:"original_filename"`
		TotalCount       int    `db:"total_count"`
		SuccessCount     int    `db:"success_count"`
		FailedCount      int    `db:"failed_count"`
		SkippedCount     int    `db:"skipped_count"`
		InsertedCount    int    `db:"inserted_count"`
		SourceLink       string `db:"source_link"`
		SourceLogicalID  string `db:"source_logical_id"`
		SourceTitle      string `db:"source_title"`
	}
	batches := []batchRow{}
	if err := s.app.DB().NewQuery(
		`SELECT j.id, j.created, COALESCE(j.finished_at, '') AS finished_at,
		        COALESCE(j.status, '') AS status, COALESCE(j.mode, '') AS mode,
		        COALESCE(j.original_filename, '') AS original_filename,
		        COALESCE(j.total_count, 0) AS total_count,
		        COALESCE(j.success_count, 0) AS success_count,
		        COALESCE(j.failed_count, 0) AS failed_count,
		        COALESCE(j.skipped_count, 0) AS skipped_count,
		        (SELECT COUNT(*) FROM pages pp WHERE pp.import_job = j.id AND pp.status != 'importing') AS inserted_count,
		        CASE WHEN COALESCE(j.source_link, '') = '' THEN 'unknown' ELSE j.source_link END AS source_link,
		        COALESCE(src.logical_id, '') AS source_logical_id,
		        COALESCE(src.title, '') AS source_title
		 FROM import_jobs j
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE j.project = {:project}
		 ORDER BY j.created DESC`,
	).Bind(params).All(&batches); err != nil {
		return apis.NewBadRequestError("读取导入台账失败。", err)
	}

	// 来源覆盖：按来源聚合「实际创建且已交付的条目」（pages 计数），无来源归入空来源。
	// LEFT JOIN import_jobs：pages.import_job 是可选项，缺作业关联的合法条目不能丢。
	type sourceAgg struct {
		LogicalID string `db:"logical_id"`
		Title     string `db:"title"`
		Rows      int    `db:"rows"`
	}
	sourceAggs := []sourceAgg{}
	if err := s.app.DB().NewQuery(
		`SELECT COALESCE(src.logical_id, '') AS logical_id,
		        COALESCE(src.title, '') AS title,
		        COUNT(*) AS rows
		 FROM pages p
		 LEFT JOIN import_jobs j ON j.id = p.import_job
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE p.project = {:project}
		   AND p.status != 'importing'
		 GROUP BY 1, 2
		 ORDER BY 3 DESC, 1`,
	).Bind(params).All(&sourceAggs); err != nil {
		return apis.NewBadRequestError("读取来源覆盖失败。", err)
	}

	// 入册行数 = 实际创建且已交付的条目数（排除 importing 暂存页）。
	var importedRows int
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) FROM pages WHERE project = {:project} AND status != 'importing'`,
	).Bind(params).Row(&importedRows); err != nil {
		return apis.NewBadRequestError("读取入册行数失败。", err)
	}

	// 未知来源行数 = 无法解析到已登记来源（缺作业/来源关联，或来源登记已被删）的实际条目数。
	// 与来源覆盖的「空来源桶」同一判定依据（都看 src 能不能 JOIN 到），避免两处口径漂移。
	var unknownSourceRows int
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) FROM pages p
		 LEFT JOIN import_jobs j ON j.id = p.import_job
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE p.project = {:project}
		   AND p.status != 'importing'
		   AND (src.id IS NULL OR j.source_link IS NULL OR j.source_link = '' OR j.source_link = 'unknown')`,
	).Bind(params).Row(&unknownSourceRows); err != nil {
		return apis.NewBadRequestError("读取未知来源行数失败。", err)
	}

	// 待返工条数 = 下游退回 A 线、status='rework' 的条目数。
	var reworkCount int
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) FROM pages WHERE project = {:project} AND status = 'rework'`,
	).Bind(params).Row(&reworkCount); err != nil {
		return apis.NewBadRequestError("读取待返工条数失败。", err)
	}

	// 输入行数从批次列表就地汇总：所有批次 total_count 之和（含跳过的输入行）。
	totalBatches := len(batches)
	totalRows := 0
	for _, b := range batches {
		totalRows += b.TotalCount
	}

	sources := make([]map[string]any, 0, len(sourceAggs))
	for _, sa := range sourceAggs {
		sources = append(sources, map[string]any{
			"logical_id": sa.LogicalID,
			"title":      sa.Title,
			"rows":       sa.Rows,
		})
	}

	batchViews := make([]map[string]any, 0, len(batches))
	for _, b := range batches {
		batchViews = append(batchViews, map[string]any{
			"id":                b.ID,
			"created":           b.Created,
			"finished_at":       b.FinishedAt,
			"status":            b.Status,
			"mode":              b.Mode,
			"original_filename": b.OriginalFilename,
			"total_count":       b.TotalCount,
			"success_count":     b.SuccessCount,
			"failed_count":      b.FailedCount,
			"skipped_count":     b.SkippedCount,
			"inserted_count":    b.InsertedCount,
			"source_link":       b.SourceLink,
			"source_logical_id": b.SourceLogicalID,
			"source_title":      b.SourceTitle,
		})
	}

	return c.JSON(http.StatusOK, map[string]any{
		"batches": batchViews,
		"summary": map[string]any{
			"total_batches":       totalBatches,
			"total_rows":          totalRows,
			"imported_rows":       importedRows,
			"unknown_source_rows": unknownSourceRows,
			"rework_count":        reworkCount,
			"sources":             sources,
		},
	})
}
