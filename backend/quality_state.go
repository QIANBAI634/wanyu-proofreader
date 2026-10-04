package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// #172 条目质量状态 v0：与 status 正交的一维「这条资料能不能作为当前交付结果用」。
//
// 三个取值必须与迁移 pb_migrations/1789200400_page_quality_state.js 的 STATES
// 逐字一致；改了那边不改这里，库里会存进一个本包拒绝识别的值。
const (
	qualityStateCandidate = "candidate"
	qualityStateValidated = "validated"
	qualityStateWithheld  = "withheld"
)

// qualityStateBasisMax 与迁移里 quality_state_basis 的 max 一致（按码点计）。
const qualityStateBasisMax = 500

var qualityStateLabels = map[string]string{
	qualityStateCandidate: "待定",
	qualityStateValidated: "已确认",
	qualityStateWithheld:  "暂缓外发",
}

func qualityStateLabel(state string) string {
	if label, ok := qualityStateLabels[state]; ok {
		return label
	}
	return state
}

func isValidQualityState(state string) bool {
	_, ok := qualityStateLabels[state]
	return ok
}

// normalizeQualityState 把空值归一为 candidate。
//
// 库里不该出现空值（迁移回填了存量、创建时由下面的 OnRecordCreate 归一），但读取侧
// 仍然照空值兜底：属性规则落地前检出的旧库、手工 SQL、以及任何绕过 Go 与 JS 两处
// 归一的写入都可能留下空值。v0 的语义是「空 = candidate」，不是「未知」——若将来
// 需要区分「没标注」与「标注为待定」，那要另加取值，不能靠空串表达。
func normalizeQualityState(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return qualityStateCandidate
	}
	return trimmed
}

// validateQualityStateChange 是纯函数：只看当前值、目标值与理由，不起服务、不读库，
// 因此状态机本身可以逐条单测。
//
// 规则：
//  1. 目标值必须是三值之一；
//  2. 目标值与当前值相同 → 拒绝。理由不是「懒」，而是本 issue 的验收要求
//     「不能只改一个裸枚举而没有理由」：一个什么都不改变的写入如果被接受，审计三列
//     就会被刷新成「看起来有人最近确认过」，而状态本身没动。要改依据请明确走一次
//     真实的状态变更。
//  3. 目标为 validated / withheld → 必须有非空 basis。这两者都会改变「这条能不能外发」
//     这件事，v0 要求每次都留理由；
//  4. 退回 candidate 是撤销动作，basis 可空。
func validateQualityStateChange(current, next, basis string) error {
	if !isValidQualityState(next) {
		return fmt.Errorf("质量状态只能是 candidate、validated 或 withheld。")
	}
	if next == normalizeQualityState(current) {
		return fmt.Errorf("条目已经是「%s」，无需变更。", qualityStateLabel(next))
	}
	// 长度上限在 candidate 早退**之前**判：退回 candidate 时依据可以留空，但留了就要合法。
	// 放在早退之后，一条 501 码点的依据会先过这里、再由 app.Save 的 TextField max 拒掉，
	// 调用方只看到「保存质量状态失败。」而拿不到真正的原因。
	if utf8.RuneCountInString(basis) > qualityStateBasisMax {
		return fmt.Errorf("依据最多 %d 个字符。", qualityStateBasisMax)
	}
	if next == qualityStateCandidate {
		return nil
	}
	if strings.TrimSpace(basis) == "" {
		return fmt.Errorf("把条目标为「%s」必须写明依据。", qualityStateLabel(next))
	}
	return nil
}

// qualityStateView 是路由回给前端的最小投影：状态 + 最近一次变更的三列审计。
func qualityStateView(page *core.Record) map[string]any {
	return map[string]any{
		"id":           page.Id,
		"project":      page.GetString("project"),
		"qualityState": normalizeQualityState(page.GetString("quality_state")),
		"qualityBy":    page.GetString("quality_state_by"),
		"qualityAt":    page.GetString("quality_state_at"),
		"qualityBasis": page.GetString("quality_state_basis"),
	}
}

func (s *importService) registerQualityState() {
	// 创建时归一：字段在迁移里是 required=false（否则既有的导入与校对创建路径会在
	// 校验期集体失败），所以这里补上 v0 的缺省值，让库里不出现空串、汇总不必 COALESCE。
	// 走的是模型层钩子而不是 API 钩子，因为导入服务是直接 app.Save 建记录的。
	s.app.OnRecordCreate("pages").BindFunc(func(e *core.RecordEvent) error {
		if strings.TrimSpace(e.Record.GetString("quality_state")) == "" {
			e.Record.Set("quality_state", qualityStateCandidate)
		}
		return e.Next()
	})

	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/pages/{pageId}/quality-state",
			s.setPageQualityState,
		).Bind(apis.RequireAuth("users"))
		e.Router.GET(
			"/api/fangji/projects/{projectId}/quality-summary",
			s.projectQualitySummary,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

func (s *importService) setPageQualityState(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	auth, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}

	page, err := s.app.FindRecordById("pages", c.Request.PathValue("pageId"))
	if err != nil || page == nil {
		return apis.NewNotFoundError("条目不存在。", err)
	}
	// 条目存在但属于别的项目：报 404 而不是 403。用 403 会承认「这个 id 在别处存在」，
	// 而对调用方来说，本路由的作用域里它就是不存在的。
	if page.GetString("project") != projectID {
		return apis.NewNotFoundError("条目不存在。", nil)
	}

	payload := struct {
		State string `json:"state"`
		Basis string `json:"basis"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", err)
	}
	basis := strings.TrimSpace(payload.Basis)
	if err := validateQualityStateChange(page.GetString("quality_state"), strings.TrimSpace(payload.State), basis); err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}

	page.Set("quality_state", strings.TrimSpace(payload.State))
	page.Set("quality_state_by", auth.Id)
	page.Set("quality_state_at", time.Now().UTC())
	page.Set("quality_state_basis", basis)
	if err := s.app.Save(page); err != nil {
		return apis.NewBadRequestError("保存质量状态失败。", err)
	}
	return c.JSON(http.StatusOK, qualityStateView(page))
}

// projectQualitySummary 用三条聚合查询回答「还有多少未收口」。
//
// 刻意走 COUNT(*) ... GROUP BY 而不是把记录读进内存计数：#172 的验收要求「汇总接口
// 与直接 SQL 对账一致，覆盖大项目」，而大项目按条读取会让「汇总」本身成为一次全表传输。
type qualityCount struct {
	Key   string `db:"key"`
	Count int    `db:"count"`
}

func (s *importService) projectQualitySummary(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	params := dbx.Params{"project": projectID}

	// 空串按 candidate 归并：正常写入不会留空值，但存量、手工 SQL 与属性规则落地前
	// 检出的库可能带着空值进来，而汇总若把它们与 candidate 分成两行，管理端会看到
	// 一个不存在的第四种状态。
	states := []qualityCount{}
	if err := s.app.DB().NewQuery(
		`SELECT COALESCE(NULLIF(quality_state, ''), 'candidate') AS key, COUNT(*) AS count
		 FROM pages WHERE project = {:project} GROUP BY 1 ORDER BY 1`,
	).Bind(params).All(&states); err != nil {
		return apis.NewBadRequestError("读取质量状态汇总失败。", err)
	}

	// 来源经 import_job 指到 #169 的 sources 登记：条目本身还没有来源键（那是 #183
	// 的范围），所以这里按「这一批是从哪份登记来的」统计，而不是按条目的来源方案。
	sources := []qualityCount{}
	if err := s.app.DB().NewQuery(
		`SELECT COALESCE(j.source, '') AS key, COUNT(*) AS count
		 FROM pages p LEFT JOIN import_jobs j ON j.id = p.import_job
		 WHERE p.project = {:project} GROUP BY 1 ORDER BY 2 DESC, 1`,
	).Bind(params).All(&sources); err != nil {
		return apis.NewBadRequestError("读取来源汇总失败。", err)
	}

	batches := []qualityCount{}
	if err := s.app.DB().NewQuery(
		`SELECT COALESCE(import_job, '') AS key, COUNT(*) AS count
		 FROM pages WHERE project = {:project} GROUP BY 1 ORDER BY 2 DESC, 1`,
	).Bind(params).All(&batches); err != nil {
		return apis.NewBadRequestError("读取导入批次汇总失败。", err)
	}

	byState := map[string]int{qualityStateCandidate: 0, qualityStateValidated: 0, qualityStateWithheld: 0}
	total := 0
	for _, row := range states {
		count := row.Count
		total += count
		// 取值表外的值不改写、不静默归并：宁可让管理端看见一个陌生的键
		// （那是迁移与代码漂移的证据），也不要把它并进 candidate 让它消失。
		byState[row.Key] += count
	}

	toList := func(rows []qualityCount, keyName string) []map[string]any {
		list := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			list = append(list, map[string]any{keyName: row.Key, "count": row.Count})
		}
		return list
	}

	return c.JSON(http.StatusOK, map[string]any{
		"total":         total,
		"byState":       byState,
		"bySource":      toList(sources, "source"),
		"byImportBatch": toList(batches, "importJob"),
	})
}
