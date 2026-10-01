package main

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
)

func pageArgument(raw string, fallback, maximum int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}

func (s *importService) registerPagination() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/projects/{projectId}/pages", s.projectPages).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/proofreading-queues", s.proofreadingQueues).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

func (s *importService) projectPages(e *core.RequestEvent) error {
	id := e.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(e, id); err != nil {
		return err
	}
	query := e.Request.URL.Query()
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 25, 100)
	filter := "project = {:project}"
	params := dbx.Params{"project": id}
	if status := query.Get("status"); status != "" {
		if status == "active" {
			filter += ` && (status = "claimed" || status = "proofreading")`
		} else {
			filter += " && status = {:status}"
			params["status"] = status
		}
	}
	if text := strings.TrimSpace(query.Get("q")); text != "" {
		filter += " && (page_number ~ {:q} || pdf_page ~ {:q} || ocr_text ~ {:q} || proofread_text ~ {:q} || proofreader.name ~ {:q} || proofreader.email ~ {:q})"
		params["q"] = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text)
	}
	for _, field := range []string{"minPage", "maxPage"} {
		if raw := query.Get(field); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 {
				return apis.NewBadRequestError("PDF 页码范围须为正整数", nil)
			}
			op := ">="
			if field == "maxPage" {
				op = "<="
			}
			filter += " && pdf_page " + op + " {:" + field + "}"
			params[field] = value
		}
	}
	var result map[string]any
	err := s.app.RunInTransaction(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("pages")
		if err != nil {
			return err
		}
		resolver := core.NewRecordFieldResolver(app, collection, nil, true)
		expr, err := search.FilterData(filter).BuildExpr(resolver, params)
		if err != nil {
			return err
		}
		countQuery := app.RecordQuery(collection).AndWhere(expr)
		if err := resolver.UpdateQuery(countQuery); err != nil {
			return err
		}
		var count int64
		err = countQuery.Select("COUNT(DISTINCT pages.id)").Row(&count)
		if err != nil {
			return err
		}
		totalPages := max(1, int(math.Ceil(float64(count)/float64(size))))
		page = min(page, totalPages)
		records, err := app.FindRecordsByFilter("pages", filter, "page_number,id", size, (page-1)*size, params)
		if err != nil {
			return err
		}
		app.ExpandRecords(records, []string{"proofreader"}, nil)
		counts := []struct {
			Status string `db:"status"`
			Count  int    `db:"count"`
		}{}
		if err := app.DB().NewQuery("SELECT status, COUNT(*) AS count FROM pages WHERE project={:project} GROUP BY status").Bind(params).All(&counts); err != nil {
			return err
		}
		stats := map[string]int{"total": 0, "unstarted": 0, "active": 0, "collecting": 0, "arbitration": 0, "approved": 0, "incomplete": 0, "completionPct": 0}
		for _, row := range counts {
			stats["total"] += row.Count
			key := map[string]string{"pending": "unstarted", "claimed": "active", "proofreading": "active", "proofread": "collecting", "arbitration": "arbitration", "approved": "approved"}[row.Status]
			if key != "" {
				stats[key] += row.Count
			}
		}
		stats["incomplete"] = stats["total"] - stats["approved"]
		if stats["total"] > 0 {
			stats["completionPct"] = int(math.Round(100 * float64(stats["approved"]) / float64(stats["total"])))
		}
		result = map[string]any{"items": records, "page": page, "perPage": size, "totalItems": count, "totalPages": totalPages, "stats": stats}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}

// One database aggregation replaces the old page-by-page record/lease/attempt queries.
const queueCTE = `WITH accessible AS (
 SELECT p.* FROM projects p JOIN project_memberships m ON m.project=p.id
 WHERE m.user={:user} AND m.role='proofreader' AND p.admin != {:user}
), classified AS (
 SELECT p.project,p.id,p.page_number,p.pdf_page,p.status,COALESCE(p.difficulty_tier,'') AS tier,
  (p.status IN ('claimed','proofreading') AND p.proofreader={:user}) AS active_mine,
  (p.status IN ('pending','proofread') OR (p.status IN ('claimed','proofreading') AND (l.id IS NULL OR l.expires_at <= {:now})))
  AND NOT (p.status IN ('claimed','proofreading') AND p.proofreader={:user})
  AND NOT EXISTS (SELECT 1 FROM proofreading_attempts a WHERE a.page=p.id AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND a.kind='proofread' AND a.proofreader={:user})
  AND (SELECT COUNT(*) FROM proofreading_attempts a WHERE a.page=p.id AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND a.kind='proofread') < MAX(2,pr.required_proofreads) AS claimable
 FROM accessible pr JOIN pages p ON p.project=pr.id AND p.status!='importing'
 LEFT JOIN task_leases l ON l.page=p.id
), queues AS (
 SELECT pr.id,pr.name,pr.description,COUNT(c.id) AS total,
 COALESCE(SUM(c.status='approved'),0) AS completed,COALESCE(SUM(c.active_mine),0) AS active_mine,
 COALESCE(SUM(c.claimable),0) AS claimable,
 COALESCE(SUM(c.claimable AND c.tier='A'),0) AS tier_a,
 COALESCE(SUM(c.claimable AND c.tier='B'),0) AS tier_b,
 COALESCE(SUM(c.claimable AND c.tier='C'),0) AS tier_c,
 COALESCE(SUM(c.claimable AND c.tier NOT IN ('A','B','C','')),0) AS tier_other,
 COALESCE(SUM(c.claimable AND c.tier=''),0) AS tier_unlabeled,
 COALESCE(MIN(CASE WHEN c.active_mine THEN printf('%020d%020d',c.page_number,c.pdf_page)||c.id END),'') AS active_key,
 COALESCE(MIN(CASE WHEN c.claimable THEN printf('%020d%020d',c.page_number,c.pdf_page)||c.id END),'') AS next_key
 FROM accessible pr LEFT JOIN classified c ON c.project=pr.id GROUP BY pr.id
) `

func queuePage(key string) any {
	if len(key) <= 40 {
		return nil
	}
	number, _ := strconv.Atoi(key[:20])
	pdf, _ := strconv.Atoi(key[20:40])
	return map[string]any{"id": key[40:], "page_number": number, "pdf_page": pdf}
}

func (s *importService) proofreadingQueues(e *core.RequestEvent) error {
	if e.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先修改初始密码", nil)
	}
	query := e.Request.URL.Query()
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 12, 50)
	params := dbx.Params{"user": e.Auth.Id, "now": time.Now().UTC().Format("2006-01-02 15:04:05.000Z")}
	var result map[string]any
	err := s.app.RunInTransaction(func(app core.App) error {
		summary := struct {
			Total     int `db:"total"`
			Active    int `db:"active"`
			Available int `db:"available"`
			Completed int `db:"completed"`
			Items     int `db:"items"`
		}{}
		if err := app.DB().NewQuery(queueCTE + `SELECT COUNT(*) AS total,COALESCE(SUM(active_mine>0),0) AS active,COALESCE(SUM(claimable>0),0) AS available,COALESCE(SUM(completed),0) AS completed,COALESCE(SUM(total),0) AS items FROM queues`).Bind(params).One(&summary); err != nil {
			return err
		}
		totalPages := max(1, (summary.Total+size-1)/size)
		page = min(page, totalPages)
		rows := []struct {
			ID          string `db:"id"`
			Name        string `db:"name"`
			Description string `db:"description"`
			Total       int    `db:"total"`
			Completed   int    `db:"completed"`
			Active      int    `db:"active_mine"`
			Claimable   int    `db:"claimable"`
			TierA       int    `db:"tier_a"`
			TierB       int    `db:"tier_b"`
			TierC       int    `db:"tier_c"`
			TierOther   int    `db:"tier_other"`
			TierBlank   int    `db:"tier_unlabeled"`
			ActiveKey   string `db:"active_key"`
			NextKey     string `db:"next_key"`
		}{}
		sql := queueCTE + fmt.Sprintf("SELECT * FROM queues ORDER BY active_mine DESC,claimable DESC,name COLLATE NOCASE,id LIMIT %d OFFSET %d", size, (page-1)*size)
		if err := app.DB().NewQuery(sql).Bind(params).All(&rows); err != nil {
			return err
		}
		items := []map[string]any{}
		for _, row := range rows {
			items = append(items, map[string]any{
				"project":    map[string]any{"id": row.ID, "name": row.Name, "description": row.Description},
				"total":      row.Total,
				"completed":  row.Completed,
				"activeMine": row.Active,
				"claimable":  row.Claimable,
				// #162：每个可领取条目恰好落在一个桶里，所以五档之和 == claimable。
				// "unlabeled" 是 difficulty_tier 为空串（从没算过），与 "other"（算过但
				// 信号不足，值就是 unknown）是两件事——大厅靠它决定要不要显示层级筛选。
				"tiers":       map[string]int{"A": row.TierA, "B": row.TierB, "C": row.TierC, "other": row.TierOther, "unlabeled": row.TierBlank},
				"tierLabeled": row.TierA + row.TierB + row.TierC + row.TierOther,
				"activePage":  queuePage(row.ActiveKey),
				"nextPage":    queuePage(row.NextKey),
			})
		}
		result = map[string]any{"items": items, "page": page, "perPage": size, "totalItems": summary.Total, "totalPages": totalPages, "summary": map[string]int{"activeProjects": summary.Active, "availableProjects": summary.Available, "completedItems": summary.Completed, "totalItems": summary.Items}}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}
