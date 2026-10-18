package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"

	"fangji/backend/scheme"
)

func TestReadingColumnsFromReportsWhatItCannotDecide(t *testing.T) {
	cases := []struct {
		name    string
		stored  string
		want    []string
		problem string
	}{
		{"not annotated yet", "", nil, "还没有标注列角色"},
		{"broken json", "{not json", nil, "无法解析"},
		{"no reading column", `{"词头":"headword","释义":"meaning"}`, nil, "没有把任何一列标成记音列"},
		{"one reading column", `{"词头":"headword","读音":"reading"}`, []string{"读音"}, ""},
		// 多个记音列必须拒绝而不是挑一个：挑哪个都会静默丢掉另一列的转换结果。
		{"two reading columns", `{"拼音":"reading","IPA":"reading"}`, nil, "一次只转换一列"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			columns, problem := readingColumnsFrom(tc.stored)
			if tc.problem == "" {
				if problem != "" {
					t.Fatalf("unexpected problem: %s", problem)
				}
				if len(columns) != len(tc.want) || (len(columns) > 0 && columns[0] != tc.want[0]) {
					t.Fatalf("columns = %v, want %v", columns, tc.want)
				}
				return
			}
			if !strings.Contains(problem, tc.problem) {
				t.Fatalf("problem %q does not mention %q", problem, tc.problem)
			}
		})
	}
}

func TestLoadSchemeRegistryWithoutADirectoryIsALegalState(t *testing.T) {
	t.Setenv(schemeAdapterDirEnv, "")
	registry, err := loadSchemeRegistry()
	if err != nil {
		t.Fatalf("an unset directory is not an error: %v", err)
	}
	if len(registry.adapters) != 0 {
		t.Fatalf("expected no adapters, got %d", len(registry.adapters))
	}
	// notice 要能被管理端显示出来，且必须点出是哪个环境变量没配——
	// 否则运维只知道"没有方案"，不知道该动哪里。
	if !strings.Contains(registry.notice, schemeAdapterDirEnv) {
		t.Fatalf("notice must name the env var: %q", registry.notice)
	}
}

func TestLoadSchemeRegistryLoadsAndRejects(t *testing.T) {
	synthetic, err := os.ReadFile(filepath.Join("scheme", "testdata", "adapter_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("loads the synthetic adapter", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "adapter.json"), synthetic, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(schemeAdapterDirEnv, dir)
		registry, err := loadSchemeRegistry()
		if err != nil {
			t.Fatal(err)
		}
		if len(registry.adapters) != 1 {
			t.Fatalf("expected 1 adapter, got %d", len(registry.adapters))
		}
		if registry.adapters["synthetic-source"] == nil {
			t.Fatalf("adapter not keyed by source_scheme_id: %v", registry.schemes())
		}
		if registry.notice != "" {
			t.Fatalf("a configured directory must not carry a notice: %q", registry.notice)
		}
	})

	t.Run("a broken rule file fails the whole load", func(t *testing.T) {
		// #189 要求「非法即启动报错，不要静默半生效」：一个坏文件不能让其余方案照跑。
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "a-broken.json"), []byte("{"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "b-good.json"), synthetic, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(schemeAdapterDirEnv, dir)
		if _, err := loadSchemeRegistry(); err == nil {
			t.Fatal("a broken rule file must fail the load")
		}
	})

	t.Run("two files claiming one scheme id is an error, not a silent override", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"a.json", "b.json"} {
			if err := os.WriteFile(filepath.Join(dir, name), synthetic, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv(schemeAdapterDirEnv, dir)
		if _, err := loadSchemeRegistry(); err == nil {
			t.Fatal("a duplicate source_scheme_id must fail the load")
		}
	})
}

// registryWithBothRuleStatuses 铺一个同时含测试夹具与可运行规则集的目录，直接问闸门。
// 两种文件都在场是这条测试的重点：闸门要能**分开**它们，而不是一律拒绝或一律放行。
func registryWithBothRuleStatuses(t *testing.T) *schemeRegistry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("scheme", "testdata", "adapter_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["source_scheme_id"] = "declared-production"
	doc["rule_status"] = "production"
	doc["rule_status_basis"] = "测试用：出处写在这里只是为了让这份文件合法，规则本身仍是合成的。"
	runnable, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	for name, content := range map[string][]byte{"fixture.json": raw, "real.json": runnable} {
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(schemeAdapterDirEnv, dir)
	registry, err := loadSchemeRegistry()
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

// TestJobAdapterIsTheOnlyGateBetweenARuleSetAndARealJob 是 owner 第 1 条阻断的替代方案的
// 落点：真实规则的形状是 #189 的事，但「没被声明为真实方案的规则进不了真实作业」是本 PR 的事。
//
// 三种情形必须是三句不同的话。混成一句的后果很具体：管理员看到「不能用」时，
// 「目录里没这套方案」要去配 FANGJI_SCHEME_ADAPTER_DIR，「这套方案声明的是 test」要去问规则作者，
// 「作业记的版本和规则对不上」要重新发起作业——三条完全不同的下一步。
func TestJobAdapterIsTheOnlyGateBetweenARuleSetAndARealJob(t *testing.T) {
	registry := registryWithBothRuleStatuses(t)

	t.Run("a scheme nobody registered is the caller's sentence, not this one", func(t *testing.T) {
		adapter, refused := registry.jobAdapter("no-such-scheme")
		if adapter != nil {
			t.Fatalf("an unregistered scheme must not resolve to an adapter: %+v", adapter)
		}
		if refused != "" {
			t.Fatalf("the refusal for an unregistered scheme comes from startConversion: %q", refused)
		}
	})

	t.Run("a registered fixture is refused, and the sentence names it", func(t *testing.T) {
		adapter, refused := registry.jobAdapter("synthetic-source")
		if adapter == nil {
			t.Fatal("a registered fixture still resolves — the caller needs its id for the message")
		}
		if !strings.Contains(refused, "只能用于测试") {
			t.Fatalf("refusal does not say it is test-only: %q", refused)
		}
		for _, want := range []string{"synthetic-source", scheme.RuleStatusTest} {
			if !strings.Contains(refused, want) {
				t.Errorf("refusal does not mention %q: %q", want, refused)
			}
		}
		// 下一步做什么要写清楚：只说「不行」，管理员只能来读代码。
		if !strings.Contains(refused, "#189") {
			t.Errorf("refusal does not say who delivers the real rules: %q", refused)
		}
	})

	t.Run("declaring production is not enough while the contract is still v1", func(t *testing.T) {
		// 这条是 Codex 第二轮点名的：原来的闸门只看 rule_status，而规则文件是数据，
		// 改一个字段就能放行——测试脚手架自己就做过这件事。所以再要求契约版本：
		// v1 是 from → to 的直接映射，没有 IPA 槽位，改标签改不出 source → IPA → target。
		adapter, refused := registry.jobAdapter("declared-production")
		if adapter == nil {
			t.Fatal("a registered production rule set still resolves — the caller needs its id for the message")
		}
		if refused == "" {
			t.Fatal("a v1 rule set must not create a real job, even when it declares production")
		}
		for _, want := range []string{"schema_version=1", "source → IPA → target", "#189"} {
			if !strings.Contains(refused, want) {
				t.Errorf("refusal does not mention %q: %q", want, refused)
			}
		}
	})

	t.Run("the test build is the only build that may run a v1 rule set", func(t *testing.T) {
		// 默认构建（含 go test 与生产镜像）必须是关的；打开它的唯一办法是 `-tags schemetest`，
		// 而只有两个 scheme runner 用那个标签编译一次性二进制。
		if allowTestOnlyAdaptersForJobs {
			t.Fatal("the default build must not allow v1 adapters to drive jobs")
		}
	})

	t.Run("each refusal is its own sentence", func(t *testing.T) {
		// 未登记那句由调用方给；其余三句由本函数给出（声明为 test / v1 契约 / 放行），
		// 第四句「登记了但作业与规则对不上」由 processConversion 给。
		if _, unregistered := registry.jobAdapter("no-such-scheme"); unregistered != "" {
			t.Fatalf("gate must leave the unregistered sentence to the caller: %q", unregistered)
		}
		_, fixture := registry.jobAdapter("synthetic-source")
		_, production := registry.jobAdapter("declared-production")
		if fixture == "" || production == "" {
			t.Fatalf("both refusals must have text: fixture=%q production=%q", fixture, production)
		}
		if fixture == production {
			t.Fatalf("the test-only refusal and the v1-contract refusal collapsed into one: %q", fixture)
		}
	})
}

// TestGroupExceptionDraftsKeepsTheTablePasteable 覆盖导出草案的最后一步。
//
// adapter 的例外表以 NFC 之后的 source 为键，加载器拒绝重复键；而同一读音在不同页上
// 重复出现是常态。所以「两条结论同一个源写法」既不能原样导出两份（贴回去启动失败），
// 也不能由程序挑一份（两个人说的是两件事）。一致就合并、不一致就进 conflicts。
func TestGroupExceptionDraftsKeepsTheTablePasteable(t *testing.T) {
	rows := []reviewedConclusion{
		// 同一个写法，一条写成预组合形式、一条写成组合形式：NFC 之后是同一条。
		{PageID: "p1", Source: "kñ533", Canonical: "gu533", Reviewer: "甲", Basis: "凡例一"},
		{PageID: "p2", Source: "kñ533", Canonical: "gu533", Reviewer: "乙", Basis: "凡例一"},
		// 同一个源写法、两个不同的目标写法：裁决不了，整组进 conflicts。
		{PageID: "p3", Source: "pn4", Canonical: "be4", Reviewer: "甲", Basis: "凡例二"},
		{PageID: "p4", Source: "pn4", Canonical: "de4", Reviewer: "乙", Basis: "凡例三"},
	}

	drafts, conflicts := groupExceptionDrafts(rows)

	if len(drafts) != 1 {
		t.Fatalf("一致的重复源写法应合并成一条，得到 %d 条：%+v", len(drafts), drafts)
	}
	draft := drafts[0]
	if draft.ID != "ex:p1" || draft.Source != norm.NFC.String("kñ533") {
		t.Errorf("合并后应保留第一条的 id 与 NFC 之后的 source：%+v", draft)
	}
	if draft.Canonical != "gu533" || draft.Status != string(scheme.Reviewed) {
		t.Errorf("合并后结论与状态应保持不变：%+v", draft)
	}
	if len(draft.MergedFrom) != 1 || draft.MergedFrom[0] != "p2" {
		t.Errorf("被合并的条目要列出来，否则没人知道还有一条同义结论：%+v", draft.MergedFrom)
	}

	if len(conflicts) != 1 {
		t.Fatalf("互相矛盾的结论要整组进 conflicts，得到 %d 组：%+v", len(conflicts), conflicts)
	}
	conflict := conflicts[0]
	if conflict.Source != "pn4" || len(conflict.Conclusions) != 2 {
		t.Fatalf("冲突组应保留两条结论与它们的判定人：%+v", conflict)
	}
	for i, want := range []map[string]string{
		{"id": "ex:p3", "canonical_pronunciation": "be4", "reviewer": "甲", "basis": "凡例二"},
		{"id": "ex:p4", "canonical_pronunciation": "de4", "reviewer": "乙", "basis": "凡例三"},
	} {
		for key, value := range want {
			if conflict.Conclusions[i][key] != value {
				t.Errorf("冲突组第 %d 条的 %s = %q, want %q", i+1, key, conflict.Conclusions[i][key], value)
			}
		}
	}
	// 冲突组绝不能同时出现在 exceptions 里：贴进去的那一份就成了程序替人做的裁决。
	for _, item := range drafts {
		if item.Source == "pn4" {
			t.Fatalf("冲突组不得混进 exceptions：%+v", item)
		}
	}
}

// TestNormalizationStatusFilterAlwaysCoversBothMachineUndecidedStates 覆盖队列端点
// 的状态参数。默认值保持「只列 AMBIGUOUS」的旧语义；管理端显式传两个状态时，
// UNSUPPORTED 才第一次有了人工入口。
func TestNormalizationStatusFilterAlwaysCoversBothMachineUndecidedStates(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    []scheme.Status
		problem string
	}{
		{"empty keeps the old default", "", []scheme.Status{scheme.Ambiguous}, ""},
		{"both machine-undecided states", "AMBIGUOUS,UNSUPPORTED", []scheme.Status{scheme.Ambiguous, scheme.Unsupported}, ""},
		{"whitespace and repeats collapse", " UNSUPPORTED , AMBIGUOUS , UNSUPPORTED ", []scheme.Status{scheme.Unsupported, scheme.Ambiguous}, ""},
		{"a typo is refused, not ignored", "AMBIGUOUS,NOPE", nil, "EXACT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, problem := parseNormalizationStatuses(tc.raw)
			if tc.problem != "" {
				if !strings.Contains(problem, tc.problem) {
					t.Fatalf("problem %q does not mention %q", problem, tc.problem)
				}
				if got != nil {
					t.Fatalf("a refused value must not produce a filter: %v", got)
				}
				return
			}
			if problem != "" {
				t.Fatalf("unexpected problem: %s", problem)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("statuses = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("statuses = %v, want %v (order matters for the echoed filter)", got, tc.want)
				}
			}
		})
	}

	if got := normalizationStatusFilter([]scheme.Status{scheme.Ambiguous}); got != `normalization_status = "AMBIGUOUS"` {
		t.Errorf("single status filter = %q", got)
	}
	// 多状态只能是 `||`：PocketBase 的 filter 语法没有 IN，写 IN 会让整个 filter
	// 解析失败。括号也不能省：调用方会在前面拼 `project = {:project} && `。
	if got := normalizationStatusFilter([]scheme.Status{scheme.Ambiguous, scheme.Unsupported}); got != `(normalization_status = "AMBIGUOUS" || normalization_status = "UNSUPPORTED")` {
		t.Errorf("multi status filter = %q", got)
	}
}

// TestReviewBlockedReasonIsFourDifferentSentences 覆盖 decideNormalization 的第一道闸。
// 它挡掉四种不该出现在复核队列里的条目，而四种的下一步处置完全不同，所以不能共用一句话。
func TestReviewBlockedReasonIsFourDifferentSentences(t *testing.T) {
	cases := []struct {
		status  string
		allowed bool
		mention string
	}{
		{string(scheme.Ambiguous), true, ""},
		{string(scheme.Unsupported), true, ""},
		{"", false, "还没有跑过转换"},
		{string(scheme.Exact), false, "机器已经判定了"},
		{string(scheme.Reviewed), false, "已经有人给过结论"},
		{"NOPE", false, "不在可复核的取值范围内"},
	}
	seen := map[string]string{}
	for _, tc := range cases {
		reason := reviewBlockedReason(tc.status)
		if tc.allowed {
			if reason != "" {
				t.Errorf("status %q must be reviewable, got %q", tc.status, reason)
			}
			continue
		}
		if !strings.Contains(reason, tc.mention) {
			t.Errorf("status %q: reason %q does not mention %q", tc.status, reason, tc.mention)
		}
		if previous, ok := seen[reason]; ok {
			t.Errorf("statuses %q and %q share one sentence: %q", previous, tc.status, reason)
		}
		seen[reason] = tc.status
	}

	// 纯判据本身也要对：handler 拿它当闸，表格里多一个取值而这里没跟上就会静默放行。
	for status, want := range map[scheme.Status]bool{
		scheme.Ambiguous: true, scheme.Unsupported: true,
		scheme.Exact: false, scheme.Reviewed: false, "": false,
	} {
		if got := reviewableNormalizationStatus(status); got != want {
			t.Errorf("reviewableNormalizationStatus(%q) = %v, want %v", status, got, want)
		}
	}
}
