package scheme

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func load(t *testing.T, name string) *Adapter {
	t.Helper()
	adapter, err := LoadAdapter(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("LoadAdapter(%s): %v", name, err)
	}
	return adapter
}

// writeAdapter mutates the known-good rule file so each case below differs from a
// working adapter in exactly one way.
func writeAdapter(t *testing.T, mutate func(map[string]interface{})) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "adapter_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]interface{}{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	mutate(doc)
	path := filepath.Join(t.TempDir(), "adapter.json")
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConvertCoversAllFourStatuses(t *testing.T) {
	adapter := load(t, "adapter_synthetic.json")
	cases := []struct {
		input      string
		status     Status
		canonical  string
		candidates []string
		note       string
	}{
		{"pa533", Exact, "be533", nil, "one-to-one segments"},
		{"pan533", Exact, "bə533", nil, "longest rime wins over its own prefix"},
		{"ki21", Exact, "ʃu21", nil, "context rule rewrites the onset"},
		{"sa533", Exact, "de533", nil, "exception beats the missing onset rule"},
		{"pa21", Reviewed, "bu533", nil, "reviewed conclusion from the exception table"},
		{"n21", Ambiguous, "", []string{"u", "ə"}, "source does not distinguish them"},
		{"ma533", Unsupported, "", nil, "segment has no rule"},
		{"pa5334", Unsupported, "", nil, "digit run is not exactly one tone value"},
		{"paa533", Unsupported, "", nil, "letters where a tone belongs"},
		{"pa", Unsupported, "", nil, "no tone at all"},
		{"", Unsupported, "", nil, "empty input"},
	}
	for _, tc := range cases {
		got := Convert(tc.input, adapter)
		if got.Status != tc.status {
			t.Errorf("%s (%s): status %s, want %s (trace %v)", tc.input, tc.note, got.Status, tc.status, got.Trace)
		}
		if got.CanonicalPronunciation != tc.canonical {
			t.Errorf("%s (%s): canonical %q, want %q", tc.input, tc.note, got.CanonicalPronunciation, tc.canonical)
		}
		if strings.Join(got.Candidates, ",") != strings.Join(tc.candidates, ",") {
			t.Errorf("%s (%s): candidates %v, want %v", tc.input, tc.note, got.Candidates, tc.candidates)
		}
	}
}

func TestDeclinedResultsNeverCarryACanonicalValue(t *testing.T) {
	// #189's acceptance row: an AMBIGUOUS case must assert that no value was
	// produced. Guessing here is what makes the downstream consumer unusable.
	adapter := load(t, "adapter_synthetic.json")
	for _, input := range []string{"n21", "ma533", "pa5334", ""} {
		got := Convert(input, adapter)
		if got.Status == Exact || got.Status == Reviewed {
			t.Fatalf("%s declined as %s", input, got.Status)
		}
		if got.CanonicalPronunciation != "" {
			t.Errorf("%s: declined but still produced %q", input, got.CanonicalPronunciation)
		}
	}
}

func TestTargetLegalityRejectsAHandBuiltIllegalSyllable(t *testing.T) {
	adapter := load(t, "adapter_illegal_rewrite.json")
	got := Convert("pa533", adapter)
	if got.Status != Unsupported {
		t.Fatalf("illegal rewrite accepted: %+v", got)
	}
	if got.CanonicalPronunciation != "" {
		t.Errorf("illegal syllable leaked: %q", got.CanonicalPronunciation)
	}
	if !contains(got.Trace, "C-broken") {
		t.Errorf("trace does not name the rule that broke it: %v", got.Trace)
	}
}

func TestTraceNamesEveryRuleThatFired(t *testing.T) {
	adapter := load(t, "adapter_synthetic.json")
	got := Convert("ki21", adapter)
	for _, id := range []string{"O-k-g", "R-i-u", "T-21", "C-ki-ʃ"} {
		if !contains(got.Trace, id) {
			t.Errorf("trace %v is missing %s", got.Trace, id)
		}
	}
	ambiguous := Convert("n21", adapter)
	if !contains(ambiguous.Trace, "A-n-many") {
		t.Errorf("an ambiguous result must name the rule that raised it: %v", ambiguous.Trace)
	}
}

func TestConvertIsDeterministicByteForByte(t *testing.T) {
	adapter := load(t, "adapter_synthetic.json")
	first, err := json.Marshal(Convert("ki21", adapter))
	if err != nil {
		t.Fatal(err)
	}
	for run := 0; run < 200; run++ {
		again, err := json.Marshal(Convert("ki21", adapter))
		if err != nil {
			t.Fatal(err)
		}
		if string(again) != string(first) {
			t.Fatalf("run %d differs:\n %s\n %s", run, first, again)
		}
	}
}

func TestSourcePronunciationIsNeverRewritten(t *testing.T) {
	// #114 §2: the source layer keeps whatever the proofreader entered.
	adapter := load(t, "adapter_synthetic.json")
	for _, input := range []string{"pa533", "n21", "ma533", "ki21"} {
		if got := Convert(input, adapter); got.SourcePronunciation != input {
			t.Errorf("%s came back as %s", input, got.SourcePronunciation)
		}
	}
}

func TestResultCarriesBothSchemeIdsAndTheRuleVersion(t *testing.T) {
	adapter := load(t, "adapter_synthetic.json")
	got := Convert("pa533", adapter)
	if got.SourceScheme != "synthetic-source" || got.CanonicalScheme != "synthetic-canonical" {
		t.Errorf("scheme ids wrong: %+v", got)
	}
	if got.RuleVersion != "synthetic-v1" {
		t.Errorf("rule version %q, want synthetic-v1", got.RuleVersion)
	}
}

func TestExceptionMatchesRegardlessOfEncodingForm(t *testing.T) {
	// 仙游IPA is bimodal NFC/NFD in the real corpus, so a reviewed conclusion must
	// not silently miss because the two sides picked different byte forms. The
	// exception key is stored NFC; the input below is the NFD spelling of it.
	adapter := load(t, "adapter_synthetic.json")
	nfc := "p\u00e021"
	nfd := "pa\u030021"
	if nfc == nfd {
		t.Fatal("the fixture pair is not actually two encoding forms")
	}
	for _, input := range []string{nfc, nfd} {
		got := Convert(input, adapter)
		if got.Status != Reviewed || got.CanonicalPronunciation != "be533" {
			t.Errorf("input %q (U+%X bytes) did not hit the NFC exception: %+v",
				input, []rune(input)[1], got)
		}
	}
}

func TestExceptionValueIsStoredInNFCForm(t *testing.T) {
	// The exception path returns its value directly, without the normalisation the
	// pipeline applies at the end, so a value hand-transcribed in NFD would go out
	// in NFD. 仙游IPA is bimodal in the real corpus, and a reviewer comparing two
	// byte-different spellings of the same syllable would see a difference.
	nfcRime := "ã"
	nfdValue := "ba\u0303" + "533"
	nfcValue := "b" + nfcRime + "533"
	if nfdValue == nfcValue {
		t.Fatal("the fixture pair is not actually two encoding forms")
	}
	path := writeAdapter(t, func(d map[string]interface{}) {
		canonical := d["canonical"].(map[string]interface{})
		canonical["rimes"] = append(canonical["rimes"].([]interface{}), nfcRime)
		d["exceptions"] = []interface{}{map[string]interface{}{
			"id": "E-nfd", "source_pronunciation": "ma533",
			"canonical_pronunciation": nfdValue, "status": "EXACT", "basis": "synthetic"}}
	})
	adapter, err := LoadAdapter(path)
	if err != nil {
		t.Fatalf("LoadAdapter: %v", err)
	}
	if got := Convert("ma533", adapter); got.CanonicalPronunciation != nfcValue {
		t.Errorf("value %X is not the NFC spelling %X", got.CanonicalPronunciation, nfcValue)
	}
}

func TestLoadAdapterHasNoDefaultPath(t *testing.T) {
	if _, err := LoadAdapter(""); err == nil {
		t.Fatal("an empty path resolved to something; a baked-in default is how #193 shipped a home directory")
	}
}

func TestLoadAdapterRefusesUntrustworthyRuleFiles(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(map[string]interface{})
		suggest string
	}{
		{"unknown schema version", func(d map[string]interface{}) {
			d["schema_version"] = 99
		}, "schema_version"},
		{"source equals canonical", func(d map[string]interface{}) {
			d["canonical_scheme_id"] = d["source_scheme_id"]
		}, "cannot be the same"},
		{"missing rule version", func(d map[string]interface{}) {
			d["rule_version"] = ""
		}, "rule_version is required"},
		{"tone classes are not tone values", func(d map[string]interface{}) {
			d["annotation_system"] = ToneCategory
		}, "tone_category"},
		{"duplicate rule id", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}), d["segment_map"].([]interface{})[0])
		}, "duplicate"},
		{"maps outside the canonical inventory", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}),
				map[string]interface{}{"id": "BAD", "part": "rime", "from": "m", "to": "ɨ", "basis": "x"})
		}, "canonical inventory"},
		{"one-to-many also declares to", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}), map[string]interface{}{
				"id": "BAD", "part": "rime", "from": "o", "to": "u",
				"candidates": []string{"e"}, "basis": "x"})
		}, "cannot also declare to"},
		{"two rules for the same source segment", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}), map[string]interface{}{
				"id": "BAD", "part": "rime", "from": "a", "to": "u", "basis": "x"})
		}, "both map source segment"},
		{"one-to-one and one-to-many share a source segment", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}), map[string]interface{}{
				"id": "BAD", "part": "rime", "from": "a",
				"candidates": []string{"e", "u"}, "basis": "x"})
		}, "both map source segment"},
		{"unknown segment part", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}), map[string]interface{}{
				"id": "BAD", "part": "vowel", "from": "o",
				"candidates": []string{"u"}, "basis": "x"})
		}, "unknown segment part"},
		{"one-to-many offers a value the target cannot hold", func(d map[string]interface{}) {
			d["segment_map"] = append(d["segment_map"].([]interface{}), map[string]interface{}{
				"id": "BAD", "part": "rime", "from": "o",
				"candidates": []string{"ɨ"}, "basis": "x"})
		}, "canonical inventory"},
		{"context rule names no neighbour", func(d map[string]interface{}) {
			d["context_rules"] = append(d["context_rules"].([]interface{}), map[string]interface{}{
				"id": "BAD", "rewrite_rime": "e", "basis": "x"})
		}, "can never match"},
		{"context rule keyed to a neighbour the source cannot have", func(d map[string]interface{}) {
			d["context_rules"] = append(d["context_rules"].([]interface{}), map[string]interface{}{
				"id": "BAD", "when_onset": "n", "rewrite_rime": "e", "basis": "x"})
		}, "not a source onset"},
		{"reviewed exception without a basis", func(d map[string]interface{}) {
			d["exceptions"] = []interface{}{map[string]interface{}{
				"id": "E", "source_pronunciation": "pa533",
				"canonical_pronunciation": "be533", "status": "REVIEWED"}}
		}, "needs a basis"},
		{"exception asserts a status it may not", func(d map[string]interface{}) {
			d["exceptions"] = []interface{}{map[string]interface{}{
				"id": "E", "source_pronunciation": "pa533",
				"canonical_pronunciation": "be533", "status": "AMBIGUOUS", "basis": "x"}}
		}, "EXACT or REVIEWED"},
		{"exception value outside the target inventory", func(d map[string]interface{}) {
			d["exceptions"] = []interface{}{map[string]interface{}{
				"id": "E", "source_pronunciation": "pa533",
				"canonical_pronunciation": "ga533", "status": "EXACT", "basis": "x"}}
		}, "target scheme can spell"},
		{"exception value is not a target syllable", func(d map[string]interface{}) {
			d["exceptions"] = []interface{}{map[string]interface{}{
				"id": "E", "source_pronunciation": "pa533",
				"canonical_pronunciation": "be5334", "status": "EXACT", "basis": "x"}}
		}, "target scheme can spell"},
		{"two exceptions for the same source form", func(d map[string]interface{}) {
			d["exceptions"] = append(d["exceptions"].([]interface{}), map[string]interface{}{
				"id": "BAD", "source_pronunciation": "pa21",
				"canonical_pronunciation": "de533", "status": "EXACT", "basis": "x"})
		}, "same source form once normalised"},
		{"empty canonical inventory", func(d map[string]interface{}) {
			d["canonical"] = map[string]interface{}{"onsets": []string{}, "rimes": []string{}, "tone_values": []string{}}
		}, "must declare"},
		// rule_status 必须**写出来**，这是它跟一个 bool 的全部差别所在。
		// 不写就加载不了，所以没有哪个夹具能"忘了标自己"然后悄悄拿到跑真实作业的资格。
		{"no rule status declared at all", func(d map[string]interface{}) {
			delete(d, "rule_status")
		}, "rule_status must be"},
		{"a rule status this build does not know", func(d map[string]interface{}) {
			d["rule_status"] = "maybe"
		}, "rule_status must be"},
		// production 是「可以跑真实作业」，那句话得带上出处，否则它只是个更响亮的 test。
		{"a production rule set with no stated basis", func(d map[string]interface{}) {
			d["rule_status"] = RuleStatusProduction
		}, "rule_status_basis is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadAdapter(writeAdapter(t, tc.mutate))
			var invalid ErrInvalidRule
			if !errors.As(err, &invalid) {
				t.Fatalf("loaded anyway; want a refusal mentioning %q", tc.suggest)
			}
			if !strings.Contains(invalid.Error(), tc.suggest) {
				t.Errorf("refused for the wrong reason: %v (want mention of %q)", invalid.Error(), tc.suggest)
			}
		})
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// TestMayDriveRealJobsAnswersOnlyForProduction 钉住闸门读的那一个判据本身。
// 未识别的取值也要答 false：validate() 已经不会让这种文件加载进来，这里是第二把锁——
// 「不认识」必须落在拒绝那一侧，否则将来加取值时漏改一处就会默认放行。
func TestMayDriveRealJobsAnswersOnlyForProduction(t *testing.T) {
	cases := map[string]bool{
		RuleStatusTest:       false,
		RuleStatusProduction: true,
		"":                   false,
		"PRODUCTION":         false,
		"maybe":              false,
	}
	for status, want := range cases {
		adapter := &Adapter{RuleStatus: status}
		if got := adapter.MayDriveRealJobs(); got != want {
			t.Errorf("rule_status %q: MayDriveRealJobs() = %v, want %v", status, got, want)
		}
	}
}

// TestNormalizeCanonicalIsTheOnlyThingBetweenATypoAndAHumanConclusion 覆盖 #190
// decideNormalization 的第二道闸。人工结论里的写法不是流水线产出的，是人敲进去的，
// 而这条结论会被重跑保护、会被导成规则草案——一个拼错的音节一旦写进去就会一直留在那儿。
func TestNormalizeCanonicalIsTheOnlyThingBetweenATypoAndAHumanConclusion(t *testing.T) {
	// 合成夹具的目标侧清单：声母 b/d/g/ʃ，韵母 e/u/ə，调值 533/21/4。
	adapter := load(t, "adapter_synthetic.json")
	cases := []struct {
		name    string
		value   string
		want    string
		problem string
		// 拒绝理由要不要点名目标方案。「空」那一类不该点：没有一个待拼的音节，
		// 说「拼不出来」反倒是在解释一件没发生的事。
		namesScheme bool
	}{
		{"a legal syllable", "bu533", "bu533", "", false},
		{"a legal multi-syllable value", "bu533de21", "bu533de21", "", false},
		{"a zero onset is legal", "e533", "e533", "", false},
		{"surrounding whitespace is trimmed, not rejected", "  bu533\t", "bu533", "", false},
		{"empty", "", "", "不能为空", false},
		{"whitespace only", "   ", "", "不能为空", false},
		{"an onset the target cannot spell", "za533", "", "不是", true},
		{"a rime the target cannot spell", "ba533", "", "不是", true},
		{"a tone the target cannot spell", "be9", "", "不是", true},
		{"a syllable the target cannot split at all", "be533x", "", "不是", true},
		{"letters lost upstream (two tones in a row)", "be53321", "", "不是", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := adapter.NormalizeCanonical(tc.value)
			if tc.problem == "" {
				if err != nil {
					t.Fatalf("NormalizeCanonical(%q) refused: %v", tc.value, err)
				}
				if got != tc.want {
					t.Fatalf("NormalizeCanonical(%q) = %q, want %q", tc.value, got, tc.want)
				}
				// 返回的值必须是能存进库的那一个：调用方直接拿它去 Set，
				// 返回去空白而库里留着空白就成了两套写法。
				if _, ok := adapter.parseCanonical(got); !ok {
					t.Fatalf("returned %q, which the target scheme then cannot parse", got)
				}
				return
			}
			if err == nil {
				t.Fatalf("NormalizeCanonical(%q) = %q, want a refusal mentioning %q", tc.value, got, tc.problem)
			}
			if !strings.Contains(err.Error(), tc.problem) {
				t.Fatalf("refused for the wrong reason: %v (want mention of %q)", err, tc.problem)
			}
			// 拒绝时必须给出一句能照着改的话：名单里有什么才是复核人要的信息。
			if tc.namesScheme && !strings.Contains(err.Error(), adapter.CanonicalScheme) {
				t.Errorf("refusal does not name the target scheme: %v", err)
			}
		})
	}
}
