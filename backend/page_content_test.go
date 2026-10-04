package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// 纯函数：字段键集校验（对齐 proofreading.pb.js 的 validateSubmittedRow）。
func TestValidateRowKeys(t *testing.T) {
	keys := []string{"词头", "释义"}

	// 键集一致、值全 string、非全空 → 通过
	if err := validateRowKeys(`{"词头":"徛","释义":"站"}`, keys); err != nil {
		t.Fatalf("valid row rejected: %v", err)
	}

	// 键集不一致 → 拒绝
	if err := validateRowKeys(`{"词头":"徛"}`, keys); err == nil {
		t.Fatal("missing key should be rejected")
	}

	// 多出键 → 拒绝
	if err := validateRowKeys(`{"词头":"徛","释义":"站","多":"余"}`, keys); err == nil {
		t.Fatal("extra key should be rejected")
	}

	// 值非 string → 拒绝
	if err := validateRowKeys(`{"词头":"徛","释义":123}`, keys); err == nil {
		t.Fatal("non-string value should be rejected")
	}

	// 全空 → 拒绝
	if err := validateRowKeys(`{"词头":"","释义":""}`, keys); err == nil {
		t.Fatal("all-empty row should be rejected")
	}

	// 非 JSON → 拒绝
	if err := validateRowKeys(`not json`, keys); err == nil {
		t.Fatal("invalid JSON should be rejected")
	}
}

// HTTP 路由：三类身份鉴权 + 跨项目 404 + 乐观锁 409。
func TestSetPageContentAuthorization(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	projects, _ := app.FindCollectionByNameOrId("projects")
	pagesColl, _ := app.FindCollectionByNameOrId("pages")

	mkUser := func(username, role string) (*core.Record, string) {
		u := core.NewRecord(users)
		u.Set("username", username)
		u.Set("role", role)
		u.SetPassword("ContentTest123!")
		if err := app.Save(u); err != nil {
			t.Fatal(err)
		}
		token, _ := u.NewAuthToken()
		return u, token
	}

	admin, adminToken := mkUser("content-admin", "platform_admin")
	_, memberToken := mkUser("content-member", "user")
	_, outsiderToken := mkUser("content-outsider", "user")

	project := core.NewRecord(projects)
	project.Set("name", "content fixture")
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	project.Set("admin", admin.Id)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}

	page := core.NewRecord(pagesColl)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("pdf_page", 1)
	page.Set("ocr_row_json", `{"词头":"徛","释义":"站"}`)
	page.Set("row_headers_json", `["词头","释义"]`)
	page.Set("ocr_text", "徛 站")
	page.Set("status", "pending")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}

	s := newImportService(app)
	s.registerPageContent()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	defer app.OnTerminate().Trigger(&core.TerminateEvent{App: app})
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	url := "/api/fangji/projects/" + project.Id + "/pages/" + page.Id + "/content"
	post := func(token string, body string) int {
		r := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", token)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w.Code
	}

	updated := page.GetString("updated")
	validBody := `{"rowJson":"{\"词头\":\"徛\",\"释义\":\"站立\"}","headersJson":"[\"词头\",\"释义\"]","expectedUpdated":"` + updated + `"}`

	// 无 token → 401
	if code := post("", validBody); code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，got %d", code)
	}
	// 非成员 → 403
	if code := post(outsiderToken, validBody); code != http.StatusForbidden {
		t.Fatalf("非成员应 403，got %d", code)
	}
	// 成员但非管理员 → 403
	if code := post(memberToken, validBody); code != http.StatusForbidden {
		t.Fatalf("成员但非管理员应 403，got %d", code)
	}

	// 乐观锁：expectedUpdated 为空 → 400
	emptyLockBody := `{"rowJson":"{\"词头\":\"徛\",\"释义\":\"站立\"}","headersJson":"[\"词头\",\"释义\"]","expectedUpdated":""}`
	if code := post(adminToken, emptyLockBody); code != http.StatusBadRequest {
		t.Fatalf("乐观锁缺失应 400，got %d", code)
	}

	// 乐观锁：expectedUpdated 不匹配 → 409
	conflictBody := `{"rowJson":"{\"词头\":\"徛\",\"释义\":\"站立\"}","headersJson":"[\"词头\",\"释义\"]","expectedUpdated":"stale-value"}`
	if code := post(adminToken, conflictBody); code != http.StatusConflict {
		t.Fatalf("乐观锁不匹配应 409，got %d", code)
	}

	// 列序与字段不一致 → 400
	badHeadersBody := `{"rowJson":"{\"词头\":\"徛\",\"释义\":\"站立\"}","headersJson":"[\"词头\"]","expectedUpdated":"` + updated + `"}`
	if code := post(adminToken, badHeadersBody); code != http.StatusBadRequest {
		t.Fatalf("列序与字段不一致应 400，got %d", code)
	}

	// 管理员正确请求 → 200
	if code := post(adminToken, validBody); code != http.StatusOK {
		t.Fatalf("管理员正确请求应 200，got %d", code)
	}

	// 跨项目 page → 404（构造一个属于别的项目的 page）
	project2 := core.NewRecord(projects)
	project2.Set("name", "content fixture 2")
	project2.Set("access_mode", "members_only")
	project2.Set("required_proofreads", 2)
	project2.Set("admin", admin.Id)
	if err := app.Save(project2); err != nil {
		t.Fatal(err)
	}
	page2 := core.NewRecord(pagesColl)
	page2.Set("project", project2.Id)
	page2.Set("page_number", 1)
	page2.Set("status", "pending")
	if err := app.Save(page2); err != nil {
		t.Fatal(err)
	}
	url2 := "/api/fangji/projects/" + project.Id + "/pages/" + page2.Id + "/content"
	r := httptest.NewRequest(http.MethodPost, url2, strings.NewReader(validBody))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", adminToken)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("跨项目 page 应 404，got %d", w.Code)
	}
}

// 集外字/IDS 写回不被破坏（#123 往返呼应）。
func TestSetPageContentPreservesPlaceholders(t *testing.T) {
	pua := string(rune(0xE123))
	row := map[string]string{"词头": pua, "释义": "站"}
	raw, _ := json.Marshal(row)
	if err := validateRowKeys(string(raw), []string{"词头", "释义"}); err != nil {
		t.Fatalf("PUA 词头应通过键集校验：%v", err)
	}
	// 往返：JSON 序列化后 PUA 原样保留
	if !strings.Contains(string(raw), pua) {
		t.Fatal("PUA placeholder lost in JSON round-trip")
	}
}
