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
// 「来源」经 import_jobs.source 指到 #169 的 sources 登记（条目本身还没有来源键），
// 所以「来源覆盖」按批次统计，而不是按条目。无来源的批次如实归入空来源，不猜测。
func (s *importService) projectImportLedger(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}

	params := dbx.Params{"project": projectID}

	// 批次列表：LEFT JOIN sources 拿到来源的 logical_id / title，前端无需再拼一次。
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
		        COALESCE(j.source_link, '') AS source_link,
		        COALESCE(src.logical_id, '') AS source_logical_id,
		        COALESCE(src.title, '') AS source_title
		 FROM import_jobs j
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE j.project = {:project}
		 ORDER BY j.created DESC`,
	).Bind(params).All(&batches); err != nil {
		return apis.NewBadRequestError("读取导入台账失败。", err)
	}

	// 来源覆盖：按来源聚合行数，无来源归入空来源（key 为空串）。
	type sourceAgg struct {
		LogicalID string `db:"logical_id"`
		Title     string `db:"title"`
		Rows      int    `db:"rows"`
	}
	sourceAggs := []sourceAgg{}
	if err := s.app.DB().NewQuery(
		`SELECT COALESCE(src.logical_id, '') AS logical_id,
		        COALESCE(src.title, '') AS title,
		        COALESCE(SUM(j.total_count), 0) AS rows
		 FROM import_jobs j
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE j.project = {:project}
		 GROUP BY 1, 2
		 ORDER BY 3 DESC, 1`,
	).Bind(params).All(&sourceAggs); err != nil {
		return apis.NewBadRequestError("读取来源覆盖失败。", err)
	}

	// 三个数从批次列表就地汇总：批次数量级小，不需要再开一条聚合查询。
	totalBatches := len(batches)
	totalRows := 0
	importedRows := 0
	unknownSourceRows := 0
	for _, b := range batches {
		totalRows += b.TotalCount
		importedRows += b.SuccessCount
		if b.SourceLink == "" || b.SourceLink == "unknown" {
			unknownSourceRows += b.TotalCount
		}
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
			"sources":             sources,
		},
	})
}
