package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestPaginationAndQueueIsolation(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	createUser := func(role string) *core.Record {
		user := core.NewRecord(users)
		user.Set("role", role)
		user.SetPassword("PaginationFixture123!")
		if err := app.Save(user); err != nil {
			t.Fatal(err)
		}
		return user
	}
	owner, reader, outsider := createUser("platform_admin"), createUser("user"), createUser("user")
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Paging fixture")
	project.Set("admin", owner.Id)
	project.Set("required_proofreads", 2)
	project.Set("access_mode", "members_only")
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	memberships, _ := app.FindCollectionByNameOrId("project_memberships")
	member := core.NewRecord(memberships)
	member.Set("project", project.Id)
	member.Set("user", reader.Id)
	member.Set("role", "proofreader")
	member.Set("source", "assigned")
	member.Set("created_by", owner.Id)
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}
	if err := app.RunInTransaction(func(tx core.App) error {
		for i := 1; i <= 120; i++ {
			_, err := tx.DB().NewQuery(`INSERT INTO pages(id,project,page_number,pdf_page,status,ocr_text,proofread_round) VALUES ({:id},{:project},{:number},{:number},'pending',{:text},1)`).Bind(dbx.Params{"id": fmt.Sprintf("page%011d", i), "project": project.Id, "number": i, "text": fmt.Sprintf("item-%d", i)}).Execute()
			if err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app)
	service.registerPagination()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	request := func(path string, user *core.Record, status int) map[string]any {
		t.Helper()
		token, _ := user.NewAuthToken()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", token)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
		result := map[string]any{}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	path := "/api/fangji/projects/" + project.Id + "/pages"
	request(path, reader, 403)
	page := request(path+"?page=2&perPage=25", owner, 200)
	if page["totalItems"] != float64(120) || len(page["items"].([]any)) != 25 || page["items"].([]any)[0].(map[string]any)["page_number"] != float64(26) {
		t.Fatalf("bad page: %v", page)
	}
	filtered := request(path+"?minPage=30&maxPage=35&status=pending", owner, 200)
	if filtered["totalItems"] != float64(6) {
		t.Fatalf("range count: %v", filtered)
	}
	found := request(path+"?q=item-120", owner, 200)
	if found["totalItems"] != float64(1) {
		t.Fatalf("search count: %v", found)
	}
	request(path+"?minPage=invalid", owner, 400)
	literal := request(path+"?q=%25", owner, 200)
	if literal["totalItems"] != float64(0) {
		t.Fatal("search wildcard must be literal")
	}
	capped := request(path+"?perPage=10000", owner, 200)
	if len(capped["items"].([]any)) != 100 {
		t.Fatal("unbounded page size")
	}
	// Deleting the last page must clamp the next request to a valid page.
	if _, err := app.DB().NewQuery("DELETE FROM pages WHERE project={:project} AND page_number>100").Bind(dbx.Params{"project": project.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	clamped := request(path+"?page=5&perPage=25", owner, 200)
	if clamped["page"] != float64(4) || clamped["totalItems"] != float64(100) {
		t.Fatalf("clamp failed: %v", clamped)
	}
	hidden := request("/api/fangji/proofreading-queues", outsider, 200)
	if hidden["totalItems"] != float64(0) {
		t.Fatal("unrelated projects leaked")
	}
	queues := request("/api/fangji/proofreading-queues?perPage=1", reader, 200)
	row := queues["items"].([]any)[0].(map[string]any)
	if row["claimable"] != float64(100) || row["nextPage"].(map[string]any)["page_number"] != float64(1) {
		t.Fatalf("queue: %v", row)
	}
	// #162：没算过 tier 的条目要落在 "unlabeled"，不能合成成 "unknown"。
	// 空串 = 从没算过，"unknown" = 算过但信号不足，#162 的渐进增强靠这两者可区分才成立。
	assertTiers(t, request("/api/fangji/proofreading-queues", reader, 200), map[string]float64{
		"A": 0, "B": 0, "C": 0, "other": 0, "unlabeled": 100,
	}, 0)
	if _, err := app.DB().NewQuery(`UPDATE pages SET difficulty_tier=CASE
		WHEN page_number<=3 THEN 'A' WHEN page_number<=5 THEN 'B'
		WHEN page_number=6 THEN 'unknown' ELSE '' END WHERE project={:project}`).Bind(dbx.Params{"project": project.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	assertTiers(t, request("/api/fangji/proofreading-queues", reader, 200), map[string]float64{
		"A": 3, "B": 2, "C": 0, "other": 1, "unlabeled": 94,
	}, 6)
	// A previous submission prevents this user from claiming that same round.
	if _, err := app.DB().NewQuery(`INSERT INTO proofreading_attempts(id,page,project,proofreader,round,kind,pass_no) VALUES ('attempt00000001','page00000000001',{:project},{:user},1,'proofread',1)`).Bind(dbx.Params{"project": project.Id, "user": reader.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	queues = request("/api/fangji/proofreading-queues", reader, 200)
	row = queues["items"].([]any)[0].(map[string]any)
	if row["claimable"] != float64(99) || row["nextPage"].(map[string]any)["page_number"] != float64(2) {
		t.Fatalf("repeat claim exposed: %v", row)
	}
	// 自己交过的第 1 页退出可领取计数，它的档位也必须同步退出——否则大厅筛出"A 类 3 条"
	// 而实际只能领到 2 条，筛选就是在说谎。
	assertTiers(t, queues, map[string]float64{"A": 2, "B": 2, "C": 0, "other": 1, "unlabeled": 94}, 5)
	// An active lease owned by another user is unavailable until expiration.
	if _, err := app.DB().NewQuery(`UPDATE pages SET status='claimed',proofreader={:user} WHERE id='page00000000002'`).Bind(dbx.Params{"user": outsider.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`INSERT INTO task_leases(id,page,project,holder,expires_at) VALUES ('lease0000000001','page00000000002',{:project},{:user},{:expires})`).Bind(dbx.Params{"project": project.Id, "user": outsider.Id, "expires": time.Now().UTC().Add(time.Hour).Format("2006-01-02 15:04:05.000Z")}).Execute(); err != nil {
		t.Fatal(err)
	}
	queues = request("/api/fangji/proofreading-queues", reader, 200)
	row = queues["items"].([]any)[0].(map[string]any)
	if row["claimable"] != float64(98) {
		t.Fatalf("active other lease claimable: %v", row)
	}
	// 别人手上还有有效租约的第 2 页是 A 类：它不可领取，A 就得跟着降。
	assertTiers(t, queues, map[string]float64{"A": 1, "B": 2, "C": 0, "other": 1, "unlabeled": 94}, 4)
	if _, err := app.DB().NewQuery(`UPDATE task_leases SET expires_at='2020-01-01 00:00:00.000Z'`).Execute(); err != nil {
		t.Fatal(err)
	}
	queues = request("/api/fangji/proofreading-queues", reader, 200)
	row = queues["items"].([]any)[0].(map[string]any)
	if row["claimable"] != float64(99) {
		t.Fatalf("expired lease not claimable: %v", row)
	}
	// 租约过期后第 2 页重新可领，A 类回到 2 条；自己交过的那条仍然不在里面。
	assertTiers(t, queues, map[string]float64{"A": 2, "B": 2, "C": 0, "other": 1, "unlabeled": 94}, 5)
}

// assertTiers 检查队列响应里第一项目的层级分档，并钉住两条不变量：
// 五档之和 == claimable（每个可领取条目恰好落在一个桶里，谁都不该被漏掉或重复计），
// 以及 tierLabeled == claimable - unlabeled。只比各个数字是否相等，会放过
// "某条既没进 A 也没进 unlabeled" 这种少计——而它正好是筛选数字虚高的形态。
func assertTiers(t *testing.T, payload map[string]any, want map[string]float64, labeled float64) {
	t.Helper()
	row, ok := payload["items"].([]any)[0].(map[string]any)
	if !ok {
		t.Fatalf("队列响应里没有项目: %v", payload)
	}
	tiers, ok := row["tiers"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺少 tiers 字段（#162 的层级计数）: %v", row)
	}
	sum := float64(0)
	for name, expected := range want {
		got, ok := tiers[name].(float64)
		if !ok {
			t.Fatalf("tiers 缺少 %q 或类型不对: %v", name, tiers)
		}
		if got != expected {
			t.Errorf("tiers.%s 应为 %v，实得 %v（全部: %v）", name, expected, got, tiers)
		}
		sum += got
	}
	claimable, _ := row["claimable"].(float64)
	if sum != claimable {
		t.Errorf("五档之和 %v 与 claimable %v 不等：有可领取条目没落进任何一个桶", sum, claimable)
	}
	if got, _ := row["tierLabeled"].(float64); got != labeled {
		t.Errorf("tierLabeled 应为 %v，实得 %v", labeled, got)
	}
}

func BenchmarkQueueAggregation(b *testing.B) {
	app := newSchemaTestApp(b)
	const projectID = "benchproject001"
	const userID = "benchreader0001"
	if err := app.RunInTransaction(func(tx core.App) error {
		for _, sql := range []string{
			`INSERT INTO projects(id,name,admin,required_proofreads) VALUES ('benchproject001','benchmark','benchowner00001',2)`,
			`INSERT INTO project_memberships(id,project,user,role) VALUES ('benchmember0001','benchproject001','benchreader0001','proofreader')`,
			`CREATE INDEX IF NOT EXISTS idx_attempts_page_round_kind_user ON proofreading_attempts(page,round,kind,proofreader)`,
			`CREATE INDEX IF NOT EXISTS idx_membership_user_role_project ON project_memberships(user,role,project)`,
			`CREATE INDEX IF NOT EXISTS idx_pages_project_status_order ON pages(project,status,page_number,id)`,
		} {
			if _, err := tx.DB().NewQuery(sql).Execute(); err != nil {
				return err
			}
		}
		for i := 1; i <= 10000; i++ {
			_, err := tx.DB().NewQuery(`INSERT INTO pages(id,project,page_number,pdf_page,status,ocr_text,proofread_round) VALUES ({:id},{:project},{:number},{:number},'pending',{:text},1)`).Bind(dbx.Params{"id": fmt.Sprintf("bench%010d", i), "project": projectID, "number": i, "text": strings.Repeat("文本ɑ𢶀", 100)}).Execute()
			if err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		b.Fatal(err)
	}
	params := dbx.Params{"user": userID, "now": "2026-09-09 00:00:00.000Z"}
	b.Run("old_record_scan", func(b *testing.B) {
		b.ReportAllocs()
		for n := 0; n < b.N; n++ {
			pages, err := app.FindRecordsByFilter("pages", "project={:project}", "page_number", 100000, 0, dbx.Params{"project": projectID})
			if err != nil {
				b.Fatal(err)
			}
			for _, page := range pages {
				if _, err := app.FindRecordsByFilter("proofreading_attempts", "page={:page} && round=1 && kind='proofread'", "pass_no,created", 1000, 0, dbx.Params{"page": page.Id}); err != nil {
					b.Fatal(err)
				}
			}
		}
	})
	b.Run("new_two_aggregates", func(b *testing.B) {
		b.ReportAllocs()
		for n := 0; n < b.N; n++ {
			for i := 0; i < 2; i++ {
				var count int
				if err := app.DB().NewQuery(queueCTE + "SELECT SUM(claimable) FROM queues").Bind(params).Row(&count); err != nil {
					b.Fatal(err)
				}
				if count != 10000 {
					b.Fatal(count)
				}
			}
		}
	})
	plan := []struct {
		Detail string `db:"detail"`
	}{}
	if err := app.DB().NewQuery("EXPLAIN QUERY PLAN " + queueCTE + "SELECT * FROM queues").Bind(params).All(&plan); err != nil {
		b.Fatal(err)
	}
	text := ""
	for _, row := range plan {
		text += row.Detail + "\n"
	}
	for _, index := range []string{"idx_attempts_page_round_kind_user", "idx_membership_user_role_project"} {
		if !strings.Contains(text, index) {
			b.Fatalf("index missing: %s\n%s", index, text)
		}
	}
	b.Log(text)
}
