// Package scheme converts a proofread pronunciation written in one romanization
// scheme into the canonical scheme, without ever touching the proofread value.
//
// It is the engine #189 asks for: rules come from a reviewed data file, the
// pipeline is staged, and every result carries the #114 §5 shape including a
// status and the rule identifiers that produced it.
//
// What it deliberately is not: it reads no database, writes no import, and holds
// no rule of its own. The target end of the mapping now has a real, cited
// inventory in data/ — 莆仙乡音社's 莆仙话拼音 under scheme id puxian-xiangyin (see
// Scheme), where #114 used to name that community with nothing defining it — but
// the source end still has none: every book's 凡例 states its own notation and its
// own IPA, and until those are transcribed per book there is no honest way to
// write a segment_map, which is what #114 §7 and #189's non-goals forbid. The
// rules in testdata therefore stay synthetic and labelled as such.
package scheme

import (
	"encoding/json"
	"fmt"
	"golang.org/x/text/unicode/norm"
	"os"
	"sort"
)

// Status is the #114 §5 enumeration. Only EXACT and REVIEWED carry a canonical
// value; the other two exist precisely so the engine can decline to guess.
type Status string

const (
	Exact       Status = "EXACT"
	Reviewed    Status = "REVIEWED"
	Ambiguous   Status = "AMBIGUOUS"
	Unsupported Status = "UNSUPPORTED"
)

// ToneValue and ToneCategory are the two ways 莆仙 sources mark tone. They are
// not interchangeable: 《文读字汇》's 2 is a tone class (阳平) while the
// dictionary's 2 is a contour value (阳入), and no amount of string inspection
// tells them apart, so an adapter has to say which one it is.
const (
	ToneValue    = "tone_value"
	ToneCategory = "tone_category"
)

// RuleStatus is the two-valued declaration every rule file must make. There is
// no third state and no default: see Adapter.RuleStatus for why the safe value
// must not be the one you get by writing nothing.
const (
	// RuleStatusTest marks a rule set that exists to exercise the engine. It
	// loads, it converts, and it may not create a job against real project data.
	RuleStatusTest = "test"
	// RuleStatusProduction marks a rule set that may, and requires a written
	// basis saying where the rules and the source documentation came from — the
	// provenance #190's first acceptance condition asks for by name.
	RuleStatusProduction = "production"
)

// RealJobSchemaVersion is the adapter contract a real conversion job requires:
// #189's `source notation → documented IPA → target notation`. Schema version 1
// is the older direct `from → to` jump with no IPA slot at all, so a v1 file
// carries no evidence of the two-step judgement no matter what it declares about
// itself. Until #189 ships version 2 every rule file here is version 1 and is
// therefore test-only; the disposable integration binary opts in to running one
// through a build tag, and a production build never carries that tag.
const RealJobSchemaVersion = 2

// MayDriveRealJobs is the declaration half of the gate. It answers only what the
// rule file says about itself, which is not enough on its own: what the file says
// can be edited. The caller combines this with the contract check in
// jobAdapter, and production builds further require RealJobSchemaVersion.
func (a *Adapter) MayDriveRealJobs() bool {
	return a.RuleStatus == RuleStatusProduction
}

// Segment is one row of the reviewable mapping table.
type Segment struct {
	ID      string   `json:"id"`
	Part    string   `json:"part"` // onset | rime | tone
	From    string   `json:"from"`
	To      string   `json:"to"`
	Basis   string   `json:"basis"`
	Targets []string `json:"candidates,omitempty"`
}

// ContextRule rewrites an onset or rime only when it sits next to a given
// partner. 凡例三.2 is the reason this stage exists: linked-tone sandhi is
// written as read, but nasal and stop codas are written as the original rime,
// so one string carries two phonotactic layers at once.
type ContextRule struct {
	ID           string `json:"id"`
	WhenOnset    string `json:"when_onset"`
	WhenRime     string `json:"when_rime"`
	RewriteOnset string `json:"rewrite_onset,omitempty"`
	RewriteRime  string `json:"rewrite_rime,omitempty"`
	Basis        string `json:"basis"`
}

// Exception is a whole-pronunciation override, usually the product of a human
// review feeding back into the rule file (#190 item 4).
type Exception struct {
	ID        string `json:"id"`
	Source    string `json:"source_pronunciation"`
	Canonical string `json:"canonical_pronunciation"`
	Status    Status `json:"status"`
	Reviewer  string `json:"reviewer,omitempty"`
	Basis     string `json:"basis"`
}

// Inventory is one scheme's own set of reachable segments.
type Inventory struct {
	Onsets     []string `json:"onsets"`
	Rimes      []string `json:"rimes"`
	ToneValues []string `json:"tone_values"`
}

func (inv Inventory) onsetSet() map[string]bool { return toSet(inv.Onsets) }
func (inv Inventory) rimeSet() map[string]bool  { return toSet(inv.Rimes) }
func (inv Inventory) toneSet() map[string]bool  { return toSet(inv.ToneValues) }

func toSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

// Adapter is a source scheme's rules. Everything the engine knows about a
// conversion comes from here, so a rule change is a data change with a review,
// not a code change with a deploy.
type Adapter struct {
	SchemaVersion    int    `json:"schema_version"`
	SourceScheme     string `json:"source_scheme_id"`
	CanonicalScheme  string `json:"canonical_scheme_id"`
	RuleVersion      string `json:"rule_version"`
	AnnotationSystem string `json:"annotation_system"`

	// RuleStatus says whether this rule set may drive a job against real project
	// data, and RuleStatusBasis is the written provenance a production rule set
	// has to carry. The gate that reads them lives at the call site
	// (scheme_conversion.go): this package holds no policy and touches no
	// database, so it validates the declaration and leaves the decision to the
	// caller.
	//
	// It is a required string rather than a `test_only` bool on purpose, and the
	// reason is the failure it has to survive. Every rule set shipped here today
	// is synthetic — no book's 凡例 has been transcribed into a source inventory
	// yet, that is #189 — and a synthetic value written into
	// pages.canonical_pronunciation is indistinguishable downstream from a real
	// one: it is exported, shipped, and read as the canonical scheme. A bool
	// cannot tell "absent" from "false", so a fixture that forgot to mark itself
	// would silently become eligible for real jobs. A required declaration cannot
	// be forgotten: validate() rejects a file that does not say which it is.
	RuleStatus      string `json:"rule_status"`
	RuleStatusBasis string `json:"rule_status_basis,omitempty"`

	Source     Inventory     `json:"source"`
	Canonical  Inventory     `json:"canonical"`
	Segments   []Segment     `json:"segment_map"`
	Contexts   []ContextRule `json:"context_rules"`
	Exceptions []Exception   `json:"exceptions"`

	// compiled, not serialised. Both inventories are sorted longest-first so
	// syllable parsing is deterministic and cannot depend on map iteration order.
	// The canonical side is compiled because load-time validation uses it too: it
	// is the only thing that can prove a hand-written exception value is a
	// syllable the target scheme can spell.
	sourceOnsets    []string
	sourceRimes     []string
	sourceTones     []string
	canonicalOnsets []string
	canonicalRimes  []string
	canonicalTones  []string
	onsetMap        map[string]string
	onsetIDs        map[string]string
	rimeIDs         map[string]string
	toneIDs         map[string]string
	rimeMap         map[string]string
	toneMap         map[string]string
	ambiguous       map[string]Segment
	exceptions      map[string]Exception
}

// ErrInvalidRule marks a rule file that cannot be trusted to load. LoadAdapter
// returns it rather than half-enabling an adapter: #189 asks for a startup
// failure over a silent partial rule set.
type ErrInvalidRule struct{ Reason string }

func (e ErrInvalidRule) Error() string { return "invalid scheme adapter: " + e.Reason }

// LoadAdapter reads and validates one rule file. There is no default path: a
// baked-in location is how #193/#195 ended up shipping someone's home directory.
func LoadAdapter(path string) (*Adapter, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read adapter %s: %w", path, err)
	}
	adapter := &Adapter{}
	if err := json.Unmarshal(raw, adapter); err != nil {
		return nil, ErrInvalidRule{Reason: fmt.Sprintf("%s: %v", path, err)}
	}
	if err := adapter.validate(); err != nil {
		return nil, err
	}
	return adapter, nil
}

func (a *Adapter) validate() error {
	switch {
	case a.SchemaVersion != 1:
		return ErrInvalidRule{Reason: fmt.Sprintf("schema_version %d is not supported", a.SchemaVersion)}
	case a.SourceScheme == "" || a.CanonicalScheme == "":
		return ErrInvalidRule{Reason: "source_scheme_id and canonical_scheme_id are required"}
	case a.SourceScheme == a.CanonicalScheme:
		return ErrInvalidRule{Reason: "source and canonical scheme cannot be the same"}
	case a.RuleVersion == "":
		return ErrInvalidRule{Reason: "rule_version is required: traces are meaningless without it"}
	case a.AnnotationSystem != ToneValue:
		return ErrInvalidRule{Reason: fmt.Sprintf(
			"annotation_system %q cannot be handled by this engine; %s marks tone classes, not values",
			a.AnnotationSystem, ToneCategory)}
	case a.RuleStatus != RuleStatusTest && a.RuleStatus != RuleStatusProduction:
		// Refusing to guess here is the whole point: a file that omits
		// rule_status must not load at all, because the alternative is a
		// synthetic rule set quietly inheriting whatever the default is.
		return ErrInvalidRule{Reason: fmt.Sprintf(
			"rule_status must be %q or %q, got %q: a rule set has to say whether it may drive real conversion jobs",
			RuleStatusTest, RuleStatusProduction, a.RuleStatus)}
	case a.RuleStatus == RuleStatusProduction && a.RuleStatusBasis == "":
		return ErrInvalidRule{Reason: "rule_status_basis is required for a production rule set: " +
			"it has to record where its rules and its source documentation came from"}
	}
	if len(a.Source.ToneValues) == 0 || len(a.Canonical.ToneValues) == 0 {
		return ErrInvalidRule{Reason: "both inventories must declare their tone values"}
	}
	a.sourceOnsets = byLengthDesc(a.Source.Onsets)
	a.sourceRimes = byLengthDesc(a.Source.Rimes)
	a.sourceTones = byLengthDesc(a.Source.ToneValues)
	a.canonicalOnsets = byLengthDesc(a.Canonical.Onsets)
	a.canonicalRimes = byLengthDesc(a.Canonical.Rimes)
	a.canonicalTones = byLengthDesc(a.Canonical.ToneValues)
	a.onsetMap = map[string]string{}
	a.rimeMap = map[string]string{}
	a.toneMap = map[string]string{}
	a.onsetIDs = map[string]string{}
	a.rimeIDs = map[string]string{}
	a.toneIDs = map[string]string{}
	a.ambiguous = map[string]Segment{}
	a.exceptions = map[string]Exception{}
	seen := map[string]bool{}
	// Keyed by part:from, which is what the conversion looks up: two rows on one
	// key meant the first never fired and never appeared in a trace.
	owner := map[string]string{}
	exceptionKey := map[string]string{}

	for _, seg := range a.Segments {
		if seg.ID == "" || seg.From == "" {
			return ErrInvalidRule{Reason: "every segment rule needs an id and a from"}
		}
		if seen[seg.ID] {
			return ErrInvalidRule{Reason: "duplicate segment rule id " + seg.ID}
		}
		seen[seg.ID] = true
		var values, ids map[string]string
		switch seg.Part {
		case "onset":
			values, ids = a.onsetMap, a.onsetIDs
		case "rime":
			values, ids = a.rimeMap, a.rimeIDs
		case "tone":
			values, ids = a.toneMap, a.toneIDs
		default:
			return ErrInvalidRule{Reason: seg.ID + ": unknown segment part " + seg.Part}
		}
		key := seg.Part + ":" + seg.From
		if previous, ok := owner[key]; ok {
			return ErrInvalidRule{Reason: fmt.Sprintf(
				"%s and %s both map source segment %s, so only one of them can ever take effect", previous, seg.ID, key)}
		}
		owner[key] = seg.ID
		if len(seg.Targets) > 0 {
			if seg.To != "" {
				return ErrInvalidRule{Reason: seg.ID + ": a one-to-many rule cannot also declare to"}
			}
			for _, candidate := range seg.Targets {
				if !inInventory(a.Canonical, seg.Part, candidate) {
					return ErrInvalidRule{Reason: seg.ID + ": offers " + candidate +
						", which the canonical inventory does not have, so the reviewer cannot pick it"}
				}
			}
			a.ambiguous[key] = seg
			continue
		}
		if seg.To == "" {
			return ErrInvalidRule{Reason: seg.ID + ": declares neither to nor candidates"}
		}
		if !inInventory(a.Canonical, seg.Part, seg.To) {
			return ErrInvalidRule{Reason: seg.ID + ": maps to " + seg.To + ", which the canonical inventory does not have"}
		}
		values[seg.From] = seg.To
		ids[seg.From] = seg.ID
	}

	for _, rule := range a.Contexts {
		if rule.ID == "" {
			return ErrInvalidRule{Reason: "every context rule needs an id"}
		}
		if seen[rule.ID] {
			return ErrInvalidRule{Reason: "duplicate rule id " + rule.ID}
		}
		seen[rule.ID] = true
		if rule.RewriteOnset == "" && rule.RewriteRime == "" {
			return ErrInvalidRule{Reason: rule.ID + ": rewrites nothing"}
		}
		// "rewrites nothing" was refused; "matches nothing" is the same defect and
		// was not. A rule with no neighbour is unconditional, which the pipeline has
		// no word for, and one whose neighbour no source syllable can ever have is
		// inert forever — inert also means stage 6 never sees its rewrite.
		if rule.WhenOnset == "" && rule.WhenRime == "" {
			return ErrInvalidRule{Reason: rule.ID + ": names no neighbour, so it can never match"}
		}
		if rule.WhenOnset != "" && !a.Source.onsetSet()[rule.WhenOnset] {
			return ErrInvalidRule{Reason: rule.ID + ": when_onset " + rule.WhenOnset + " is not a source onset, so it can never match"}
		}
		if rule.WhenRime != "" && !a.Source.rimeSet()[rule.WhenRime] {
			return ErrInvalidRule{Reason: rule.ID + ": when_rime " + rule.WhenRime + " is not a source rime, so it can never match"}
		}
	}

	for _, item := range a.Exceptions {
		if item.ID == "" || item.Source == "" {
			return ErrInvalidRule{Reason: "every exception needs an id and a source_pronunciation"}
		}
		if seen[item.ID] {
			return ErrInvalidRule{Reason: "duplicate rule id " + item.ID}
		}
		seen[item.ID] = true
		if item.Status != Exact && item.Status != Reviewed {
			return ErrInvalidRule{Reason: item.ID + ": an exception may only assert EXACT or REVIEWED"}
		}
		if item.Canonical == "" {
			return ErrInvalidRule{Reason: item.ID + ": " + string(item.Status) + " exception carries no value"}
		}
		if item.Status == Reviewed && item.Basis == "" {
			return ErrInvalidRule{Reason: item.ID + ": a human conclusion needs a basis"}
		}
		item.Canonical = norm.NFC.String(item.Canonical)
		key := norm.NFC.String(item.Source)
		if previous, ok := exceptionKey[key]; ok {
			return ErrInvalidRule{Reason: fmt.Sprintf(
				"%s and %s are the same source form once normalised, so only one of them can ever be found", previous, item.ID)}
		}
		exceptionKey[key] = item.ID
		// This value goes out having passed neither the parse nor stage 6, because
		// the table is consulted before the pipeline runs. Same code, load time.
		if _, ok := a.parseCanonical(item.Canonical); !ok {
			return ErrInvalidRule{Reason: item.ID + ": canonical value " + item.Canonical +
				" is not a syllable the target scheme can spell"}
		}
		a.exceptions[key] = item
	}

	return nil
}

func inInventory(inv Inventory, part, value string) bool {
	switch part {
	case "onset":
		return inv.onsetSet()[value]
	case "rime":
		return inv.rimeSet()[value]
	case "tone":
		return inv.toneSet()[value]
	}
	return false
}

// byLengthDesc orders segment options so the longest match wins and the result
// never depends on Go map iteration order.
func byLengthDesc(values []string) []string {
	out := append([]string(nil), values...)
	sort.Slice(out, func(i, j int) bool {
		if len(out[i]) != len(out[j]) {
			return len(out[i]) > len(out[j])
		}
		return out[i] < out[j]
	})
	return out
}
