package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// #124 管理侧写入路由：管理员修正「识别产出」（导入原文）的内容。
//
// pages.updateRule = null，前端 pagesService.updatePage 是死代码；本路由用
// app.Save 走模型层，绕过 main.pb.js 的 onRecordUpdateRequest（claimOnlyFields），
// 因此项目管理员能安全修正导入原文，而不会被认领守卫拦下。
//
// 只允许改导入原文三件套：ocr_row_json / ocr_text / row_headers_json。
// 校对结果（proofread_*）由校对员/仲裁产出，管理员在这里不能动。

func (s *importService) registerPageContent() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/pages/{pageId}/content",
			s.setPageContent,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// parseRowObject 对齐 proofreading.pb.js 的 parseRowObject：非空对象、≤2MiB、必须是 object。
func parseRowObject(raw string) (map[string]any, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 2*1024*1024 {
		return nil, fmt.Errorf("内容为空或过大")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, fmt.Errorf("内容格式无效")
	}
	if len(parsed) == 0 {
		return nil, fmt.Errorf("内容必须是非空字段对象")
	}
	return parsed, nil
}

// validateRowKeys 对齐 proofreading.pb.js 的 validateSubmittedRow：
// 键集必须与源 ocr_row_json 一致（或退化到「内容」），值全 string，不能全空。
func validateRowKeys(rowJSON string, sourceKeys []string) error {
	parsed, err := parseRowObject(rowJSON)
	if err != nil {
		return err
	}
	expected := append([]string{}, sourceKeys...)
	sort.Strings(expected)
	actual := make([]string, 0, len(parsed))
	for k := range parsed {
		actual = append(actual, k)
	}
	sort.Strings(actual)
	if len(expected) != len(actual) {
		return fmt.Errorf("修正字段必须与原始字段一致：%s", strings.Join(expected, "、"))
	}
	for i := range expected {
		if expected[i] != actual[i] {
			return fmt.Errorf("修正字段必须与原始字段一致：%s", strings.Join(expected, "、"))
		}
	}
	hasContent := false
	for _, k := range expected {
		v, ok := parsed[k].(string)
		if !ok {
			return fmt.Errorf("字段「%s」必须是文本", k)
		}
		if strings.TrimSpace(v) != "" {
			hasContent = true
		}
	}
	if !hasContent {
		return fmt.Errorf("修正内容不能全部为空")
	}
	return nil
}

func (s *importService) setPageContent(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	auth, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}

	page, err := s.app.FindRecordById("pages", c.Request.PathValue("pageId"))
	if err != nil || page == nil {
		return apis.NewNotFoundError("条目不存在。", err)
	}
	// 条目存在但属于别的项目：报 404 而不是 403（本路由作用域内它不存在）。
	if page.GetString("project") != projectID {
		return apis.NewNotFoundError("条目不存在。", nil)
	}

	payload := struct {
		RowJSON         string `json:"rowJson"`
		Text            string `json:"text"`
		HeadersJSON     string `json:"headersJson"`
		ExpectedUpdated string `json:"expectedUpdated"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", err)
	}

	// 乐观锁：expectedUpdated 与当前 updated 不符 → 409，避免两人同时编辑互相覆盖。
	if payload.ExpectedUpdated != "" && payload.ExpectedUpdated != page.GetString("updated") {
		return apis.NewApiError(http.StatusConflict, "条目内容已被他人修改，请刷新后重试。", nil)
	}

	// 源键集：以 ocr_row_json 为准（退化到「内容」）。
	sourceKeys := []string{"内容"}
	if raw := page.GetString("ocr_row_json"); raw != "" {
		if candidate, err := parseRowObject(raw); err == nil && len(candidate) > 0 {
			sourceKeys = make([]string, 0, len(candidate))
			for k := range candidate {
				sourceKeys = append(sourceKeys, k)
			}
		}
	}

	if err := validateRowKeys(payload.RowJSON, sourceKeys); err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}

	page.Set("ocr_row_json", strings.TrimSpace(payload.RowJSON))
	page.Set("ocr_text", strings.TrimSpace(payload.Text))
	page.Set("row_headers_json", strings.TrimSpace(payload.HeadersJSON))
	if err := s.app.Save(page); err != nil {
		return apis.NewBadRequestError("保存修正内容失败。", err)
	}
	_ = auth // auth 已用于 requireProjectManager 鉴权
	return c.JSON(http.StatusOK, map[string]any{
		"id":             page.Id,
		"updated":        page.GetString("updated"),
		"ocrRowJson":     page.GetString("ocr_row_json"),
		"ocrText":        page.GetString("ocr_text"),
		"rowHeadersJson": page.GetString("row_headers_json"),
	})
}
