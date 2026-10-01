package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// registerArtifacts 注册 #123 的服务端导出产物路由。
func (s *importService) registerArtifacts() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/exports/csv",
			s.exportCSV,
		).Bind(apis.RequireAuth("users"))
		e.Router.GET(
			"/api/fangji/artifacts/{artifactId}/download",
			s.downloadArtifact,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// toSafeCsvCell 移植自前端 frontend/src/lib/csvExport.js:1-10，逐字节对齐：
//  1. 若以（可含前导 tab/CR/空格）`=`/`+`/`-`/`@` 开头，前置单引号；
//  2. 若含 `"`/`,`/`\r`/`\n` 任一，双引号包裹并把内部 `"` 转义为 `""`。
var (
	formulaPrefixRe = regexp.MustCompile(`^[\t\r ]*[=+\-@]`)
	needsQuoteRe    = regexp.MustCompile(`[",\r\n]`)
)

func toSafeCsvCell(v any) string {
	text := ""
	if v != nil {
		text = fmt.Sprint(v)
	}
	if formulaPrefixRe.MatchString(text) {
		text = "'" + text
	}
	if needsQuoteRe.MatchString(text) {
		return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
	}
	return text
}

// orderedObject 保留 JSON 对象的键插入顺序。Go 的 map 迭代无序，
// 而前端 Object.keys 遵循 JSON 插入顺序，表头并集顺序必须逐字节一致，
// 因此用 json.Decoder 顺序读键，不能退回 map[string]any 迭代。
type orderedObject struct {
	keys   []string
	values map[string]any
}

func (o *orderedObject) set(key string, val any) {
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = val
}

func (o *orderedObject) get(key string) (any, bool) {
	v, ok := o.values[key]
	return v, ok
}

// parseRowJSON 把 JSON 字符串解析为保序对象；失败或结果非 object 返回 nil。
// 对齐前端 useStructuredRow.js 的 safeParseRowJson（空值/解析失败/非 object → null）。
func parseRowJSON(raw string) *orderedObject {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil
	}
	obj := &orderedObject{values: map[string]any{}}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil
		}
		var val any
		if err := dec.Decode(&val); err != nil {
			return nil
		}
		obj.set(key, val)
	}
	// 读掉结尾的 '}'。
	if _, err := dec.Token(); err != nil {
		return nil
	}
	return obj
}

// orderedRowHeaders 复刻前端 useStructuredRow.js 的 orderedRowHeaders：
// saved（row_headers_json）中存在于 rowObj 的键在前，rowObj 实际键按插入顺序在后。
func orderedRowHeaders(saved []string, rowObj *orderedObject) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, k := range saved {
		if _, ok := rowObj.get(k); ok && !seen[k] {
			seen[k] = true
			result = append(result, k)
		}
	}
	for _, k := range rowObj.keys {
		if !seen[k] {
			seen[k] = true
			result = append(result, k)
		}
	}
	return result
}

func (s *importService) exportCSV(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	auth, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}

	project, err := s.app.FindRecordById("projects", projectID)
	if err != nil {
		return apis.NewNotFoundError("项目不存在。", err)
	}

	pages, err := s.app.FindRecordsByFilter(
		"pages",
		fmt.Sprintf(`project = %q && status != "importing"`, projectID),
		"page_number",
		200000,
		0,
	)
	if err != nil {
		return apis.NewBadRequestError("读取项目条目失败。", err)
	}
	if len(pages) == 0 {
		return apis.NewBadRequestError("当前项目暂无可导出的条目", nil)
	}

	headers := []string{}
	type exportedRow struct {
		pageNumber string
		rowObj     *orderedObject
	}
	rows := make([]exportedRow, 0, len(pages))
	for _, page := range pages {
		var rowObj *orderedObject
		if page.GetString("status") == "approved" {
			rowObj = parseRowJSON(page.GetString("proofread_row_json"))
		}
		if rowObj == nil {
			rowObj = parseRowJSON(page.GetString("ocr_row_json"))
		}
		if rowObj == nil {
			text := page.GetString("proofread_text")
			if text == "" {
				text = page.GetString("ocr_text")
			}
			rowObj = &orderedObject{keys: []string{"内容"}, values: map[string]any{"内容": text}}
		}

		saved := []string{}
		if raw := page.GetString("row_headers_json"); raw != "" {
			_ = json.Unmarshal([]byte(raw), &saved)
		}
		for _, k := range orderedRowHeaders(saved, rowObj) {
			if !containsStr(headers, k) {
				headers = append(headers, k)
			}
		}

		pageNumber := ""
		if n := page.GetInt("pdf_page"); n != 0 {
			pageNumber = strconv.Itoa(n)
		} else if n := page.GetInt("page_number"); n != 0 {
			pageNumber = strconv.Itoa(n)
		}
		rows = append(rows, exportedRow{pageNumber: pageNumber, rowObj: rowObj})
	}

	finalHeaders := append([]string{"PDF页码"}, headers...)
	lines := make([]string, 0, len(rows)+1)
	headerCells := make([]string, len(finalHeaders))
	for i, h := range finalHeaders {
		headerCells[i] = toSafeCsvCell(h)
	}
	lines = append(lines, strings.Join(headerCells, ","))
	for _, row := range rows {
		cells := make([]string, len(finalHeaders))
		cells[0] = toSafeCsvCell(row.pageNumber)
		for i, h := range headers {
			val, _ := row.rowObj.get(h)
			cells[i+1] = toSafeCsvCell(val)
		}
		lines = append(lines, strings.Join(cells, ","))
	}
	csvText := "\uFEFF" + strings.Join(lines, "\r\n")

	safeName := regexp.MustCompile(`[\\/:*?"<>|]`).ReplaceAllString(project.GetString("name"), "_")
	fileName := safeName + "_校对结果.csv"

	file, err := filesystem.NewFileFromBytes([]byte(csvText), fileName)
	if err != nil {
		return apis.NewBadRequestError("生成导出文件失败。", err)
	}

	collection, err := s.app.FindCollectionByNameOrId("project_artifacts")
	if err != nil {
		return apis.NewBadRequestError("产物存储尚未初始化。", err)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	form.Load(map[string]any{
		"project":    projectID,
		"kind":       "csv",
		"file_name":  fileName,
		"file_size":  len(csvText),
		"created_by": auth.Id,
	})
	record.Set("file", file)
	if err := form.Submit(); err != nil {
		return apis.NewBadRequestError("保存导出产物失败。", err)
	}
	return c.JSON(http.StatusCreated, record)
}

func (s *importService) downloadArtifact(c *core.RequestEvent) error {
	artifactID := c.Request.PathValue("artifactId")
	artifact, err := s.app.FindRecordById("project_artifacts", artifactID)
	if err != nil {
		return apis.NewNotFoundError("产物不存在。", err)
	}
	if _, _, err := s.requireProjectManager(c, artifact.GetString("project")); err != nil {
		return err
	}

	reader, closeFn, err := s.openRecordFile(artifact, "file")
	if err != nil {
		return apis.NewBadRequestError("产物文件缺失。", err)
	}
	defer closeFn()
	data, err := io.ReadAll(reader)
	if err != nil {
		return apis.NewBadRequestError("读取产物失败。", err)
	}

	fileName := strings.ReplaceAll(artifact.GetString("file_name"), `"`, "_")
	c.Response.Header().Set("Cache-Control", "private, no-store")
	c.Response.Header().Set("X-Content-Type-Options", "nosniff")
	c.Response.Header().Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	return c.Blob(http.StatusOK, "text/csv; charset=utf-8", data)
}

func containsStr(list []string, target string) bool {
	for _, s := range list {
		if s == target {
			return true
		}
	}
	return false
}
