package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

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

// parseRowObject 对齐 proofreading.pb.js 的 parseRowObject：非空对象、必须是 object。
// 长度上限按码点计（utf8.RuneCountInString），与 JS 的 value.length（UTF-16 单元）
// 同一量级，避免汉字被按字节放大 3 倍误拒。
func parseRowObject(raw string) (map[string]any, error) {
	value := strings.TrimSpace(raw)
	if value == "" || utf8.RuneCountInString(value) > 2*1024*1024 {
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
	_, _, err := s.requireProjectManager(c, projectID)
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
		HeadersJSON     string `json:"headersJson"`
		ExpectedUpdated string `json:"expectedUpdated"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", err)
	}

	// 乐观锁：expectedUpdated 必填，与当前 updated 不符 → 409，避免两人同时编辑互相覆盖。
	if payload.ExpectedUpdated == "" {
		return apis.NewBadRequestError("缺少乐观锁版本号。", nil)
	}
	if payload.ExpectedUpdated != page.GetString("updated") {
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

	// row_headers_json 必须是列名数组，且集合等于刚验过的键集（数组顺序即列序）。
	headers, err := parseHeaderList(payload.HeadersJSON)
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	if !sameKeySet(headers, sourceKeys) {
		return apis.NewBadRequestError(
			fmt.Sprintf("列序必须与字段一致：%s", strings.Join(sourceKeys, "、")), nil)
	}

	// ocr_text 在服务端按 rowJson + 表头序生成，不接受调用方传入（保证与
	// import_service.go 的 entryText 拼接 / frontend useStructuredRow.js 的 composeRowText 同口径）。
	rowObj, _ := parseRowObject(payload.RowJSON)
	text := composeRowText(headers, rowObj)

	page.Set("ocr_row_json", strings.TrimSpace(payload.RowJSON))
	page.Set("ocr_text", text)
	page.Set("row_headers_json", strings.TrimSpace(payload.HeadersJSON))
	if err := s.app.Save(page); err != nil {
		return apis.NewBadRequestError("保存修正内容失败。", err)
	}
	return c.JSON(http.StatusOK, map[string]any{
		"id":             page.Id,
		"updated":        page.GetString("updated"),
		"ocrRowJson":     page.GetString("ocr_row_json"),
		"ocrText":        page.GetString("ocr_text"),
		"rowHeadersJson": page.GetString("row_headers_json"),
	})
}

// parseHeaderList 解析 row_headers_json：必须是字符串数组。
func parseHeaderList(raw string) ([]string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, fmt.Errorf("列序不能为空")
	}
	var headers []string
	if err := json.Unmarshal([]byte(value), &headers); err != nil {
		return nil, fmt.Errorf("列序格式无效")
	}
	if len(headers) == 0 {
		return nil, fmt.Errorf("列序不能为空")
	}
	return headers, nil
}

// sameKeySet 判断两个列表的「集合」是否相等（忽略顺序）。
func sameKeySet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	setA := make(map[string]bool, len(a))
	for _, k := range a {
		setA[k] = true
	}
	for _, k := range b {
		if !setA[k] {
			return false
		}
	}
	return true
}

// composeRowText 按列序拼接非空值，对齐 frontend/src/composables/useStructuredRow.js 的 composeRowText。
func composeRowText(headers []string, rowObj map[string]any) string {
	parts := make([]string, 0, len(headers))
	for _, h := range headers {
		if v, ok := rowObj[h].(string); ok {
			if trimmed := strings.TrimSpace(v); trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
	}
	return strings.Join(parts, " ")
}
