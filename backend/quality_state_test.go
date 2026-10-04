package main

import (
	"os"
	"strings"
	"testing"
)

func TestNormalizeQualityState(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		// 空值按 v0 语义等同 candidate，而不是「未知」。三种空法都要归到同一个桶，
		// 否则汇总里会出现一个不存在的第四种状态。
		{"empty", "", qualityStateCandidate},
		{"spaces", "   ", qualityStateCandidate},
		{"explicit candidate", qualityStateCandidate, qualityStateCandidate},
		{"validated", qualityStateValidated, qualityStateValidated},
		{"withheld", qualityStateWithheld, qualityStateWithheld},
		{"padded value keeps its identity", " withheld ", qualityStateWithheld},
		// 取值表外的值原样返回：调用方要能看出来，不能被静默改写成 candidate。
		{"unknown value is not rewritten", "quarantine", "quarantine"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeQualityState(tc.raw); got != tc.want {
				t.Fatalf("normalizeQualityState(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidateQualityStateChange(t *testing.T) {
	longBasis := strings.Repeat("据", qualityStateBasisMax+1)
	atLimit := strings.Repeat("据", qualityStateBasisMax)

	cases := []struct {
		name     string
		current  string
		next     string
		basis    string
		wantErr  bool
		errMatch string
	}{
		{"candidate to validated with basis", qualityStateCandidate, qualityStateValidated, "多轮一致且无争议", false, ""},
		{"candidate to withheld with basis", qualityStateCandidate, qualityStateWithheld, "权利未决", false, ""},
		// 空值在库里等同 candidate，所以「空 → validated」是一次真实的状态变更。
		{"legacy empty row to validated", "", qualityStateValidated, "补标", false, ""},
		{"withheld back to validated with basis", qualityStateWithheld, qualityStateValidated, "争议已解决", false, ""},
		{"validated back to candidate needs no basis", qualityStateValidated, qualityStateCandidate, "", false, ""},
		// 退回 candidate 时依据可以留空，但**留了**就要合法：上限检查必须在 candidate
		// 早退之前，否则这条会在 app.Save 的 TextField max 上失败，而调用方看不到原因。
		{"candidate target still enforces the basis limit", qualityStateValidated, qualityStateCandidate, longBasis, true, "最多 500 个字符"},

		{"reject unknown target", qualityStateCandidate, "quarantine", "理由", true, "candidate、validated 或 withheld"},
		{"reject empty target", qualityStateCandidate, "", "理由", true, "candidate、validated 或 withheld"},
		// 同值写入被拒绝：它不改变任何状态，却会刷新审计三列，让「最近一次确认」
		// 看起来比实际新。要改依据就得走一次真实变更。
		{"reject no-op on same value", qualityStateValidated, qualityStateValidated, "重新确认", true, "已经是"},
		{"reject no-op against legacy empty row", "", qualityStateCandidate, "", true, "已经是"},
		// 两个会改变「能不能外发」的目标都必须带理由。
		{"withheld requires basis", qualityStateCandidate, qualityStateWithheld, "", true, "必须写明依据"},
		{"withheld rejects blank basis", qualityStateCandidate, qualityStateWithheld, "   ", true, "必须写明依据"},
		{"validated requires basis", qualityStateCandidate, qualityStateValidated, "", true, "必须写明依据"},
		// 上限按码点计，与迁移里 TextField max=500 的口径一致（不是按字节）。
		{"basis at rune limit", qualityStateCandidate, qualityStateValidated, atLimit, false, ""},
		{"basis over rune limit", qualityStateCandidate, qualityStateValidated, longBasis, true, "最多 500 个字符"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateQualityStateChange(tc.current, tc.next, tc.basis)
			if tc.wantErr && err == nil {
				t.Fatalf("expected an error for %s -> %s", tc.current, tc.next)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr && tc.errMatch != "" && !strings.Contains(err.Error(), tc.errMatch) {
				t.Fatalf("error %q does not mention %q", err.Error(), tc.errMatch)
			}
		})
	}
}

// 三个取值与迁移里的 STATES 是两份字面量，漂移的表现是「库里存得进、路由认不出」。
// 这里把迁移源码读出来比对，与 postSnapshotSelectFields 的镜像测试同一手法。
func TestQualityStateValuesTrackMigration(t *testing.T) {
	raw, err := os.ReadFile("pb_migrations/1789200400_page_quality_state.js")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	source := string(raw)
	marker := "const STATES = ["
	start := strings.Index(source, marker)
	if start < 0 {
		t.Fatalf("迁移里找不到 STATES 定义")
	}
	list := source[start+len(marker):]
	list = list[:strings.Index(list, "]")]
	for _, want := range []string{qualityStateCandidate, qualityStateValidated, qualityStateWithheld} {
		if !strings.Contains(list, `"`+want+`"`) {
			t.Errorf("迁移的 STATES 不含 %q: %s", want, strings.TrimSpace(list))
		}
	}
	if got := strings.Count(list, `"`) / 2; got != len(qualityStateLabels) {
		t.Errorf("迁移的 STATES 有 %d 个值，本包识别 %d 个: %s", got, len(qualityStateLabels), strings.TrimSpace(list))
	}
}
