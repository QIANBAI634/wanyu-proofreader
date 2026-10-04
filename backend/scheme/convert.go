package scheme

import (
	"golang.org/x/text/unicode/norm"
	"strings"
)

// Result is one conversion in the #114 §5 shape. CanonicalPronunciation is only
// ever filled for EXACT and REVIEWED: an AMBIGUOUS result that carried a guess
// would be indistinguishable from a certain one downstream.
type Result struct {
	SourceScheme           string   `json:"source_scheme_id"`
	SourcePronunciation    string   `json:"source_pronunciation_proofread"`
	CanonicalScheme        string   `json:"canonical_scheme_id"`
	CanonicalPronunciation string   `json:"canonical_pronunciation"`
	Status                 Status   `json:"normalization_status"`
	RuleVersion            string   `json:"normalization_rule_version"`
	Trace                  []string `json:"normalization_trace"`
	Candidates             []string `json:"candidates,omitempty"`
}

type syllable struct{ onset, rime, tone string }

// Convert runs the #114 §6 pipeline: Unicode normalisation, syllable parsing,
// segment mapping, context rules, exception table, target legality check. The
// exception table is looked up right after normalisation, not at §6's fifth
// position: a human conclusion exists precisely for sources the earlier stages
// cannot handle, and running them first would decline before it was consulted.
// Stage 6's guarantee moves to LoadAdapter for that one exit, which is why
// Convert trusts the values it finds in adapter.exceptions.
//
// The input is never mutated and never returned in a rewritten form: the source
// layer is the proofreader's work and stays as it was (#114 §2).
func Convert(input string, adapter *Adapter) Result {
	result := Result{
		SourceScheme:        adapter.SourceScheme,
		SourcePronunciation: input,
		CanonicalScheme:     adapter.CanonicalScheme,
		RuleVersion:         adapter.RuleVersion,
		Status:              Exact,
		Trace:               []string{},
	}
	corrected := norm.NFC.String(strings.TrimSpace(input))

	if item, ok := adapter.exceptions[corrected]; ok {
		result.Status = item.Status
		result.CanonicalPronunciation = item.Canonical
		result.Trace = append(result.Trace, item.ID)
		return result
	}

	syllables, ok := adapter.parse(corrected)
	if !ok {
		return decline(result, Unsupported, "source_pronunciation_does_not_parse")
	}

	parts := make([]string, 0, len(syllables))
	for _, unit := range syllables {
		onset, rime, tone := unit.onset, unit.rime, unit.tone

		if rule, ok := adapter.ambiguityFor(unit); ok {
			// The reviewer has to see both the alternatives and which rule raised
			// them; a bare AMBIGUOUS with no candidates is a dead end.
			result.Candidates = append(result.Candidates, rule.Targets...)
			result.Trace = append(result.Trace, rule.ID)
			return decline(result, Ambiguous, "segment_is_one_to_many")
		}

		mappedOnset, mappedRime, mappedTone, applied, missing := adapter.mapSegments(onset, rime, tone)
		if missing != "" {
			return decline(result, Unsupported, "no_rule_for_segment:"+missing)
		}
		result.Trace = append(result.Trace, applied...)
		onset, rime, tone = mappedOnset, mappedRime, mappedTone

		for _, rule := range adapter.Contexts {
			if rule.matches(unit) {
				if rule.RewriteOnset != "" {
					onset = rule.RewriteOnset
				}
				if rule.RewriteRime != "" {
					rime = rule.RewriteRime
				}
				result.Trace = append(result.Trace, rule.ID)
			}
		}

		if problem := adapter.legal(onset, rime, tone); problem != "" {
			return decline(result, Unsupported, "target_legality:"+problem)
		}
		parts = append(parts, onset+rime+tone)
	}

	result.CanonicalPronunciation = strings.Join(parts, "")
	return result
}

func decline(result Result, status Status, reason string) Result {
	result.Status = status
	result.CanonicalPronunciation = ""
	result.Trace = append(result.Trace, "decline:"+reason)
	return result
}

// mapSegments applies the segment table and returns the rules it used. The rule
// identifiers matter as much as the value: #189 asks for a trace that can list
// every record affected when one rule changes.
func (a *Adapter) mapSegments(onset, rime, tone string) (string, string, string, []string, string) {
	var applied []string
	mapped := func(table, ids map[string]string, key, part string) (string, string) {
		if key == "" {
			return "", ""
		}
		value, ok := table[key]
		if !ok {
			return "", part + ":" + key
		}
		applied = append(applied, ids[key])
		return value, ""
	}
	convertedOnset, problem := mapped(a.onsetMap, a.onsetIDs, onset, "onset")
	if problem != "" {
		return "", "", "", nil, problem
	}
	convertedRime, problem := mapped(a.rimeMap, a.rimeIDs, rime, "rime")
	if problem != "" {
		return "", "", "", nil, problem
	}
	convertedTone, problem := mapped(a.toneMap, a.toneIDs, tone, "tone")
	if problem != "" {
		return "", "", "", nil, problem
	}
	return convertedOnset, convertedRime, convertedTone, applied, ""
}

func (a *Adapter) ambiguityFor(unit syllable) (Segment, bool) {
	for _, key := range []string{"onset:" + unit.onset, "rime:" + unit.rime, "tone:" + unit.tone} {
		if rule, ok := a.ambiguous[key]; ok {
			return rule, true
		}
	}
	return Segment{}, false
}

func (r ContextRule) matches(unit syllable) bool {
	return (r.WhenOnset == "" || r.WhenOnset == unit.onset) &&
		(r.WhenRime == "" || r.WhenRime == unit.rime) &&
		(r.WhenOnset != "" || r.WhenRime != "")
}

// legal is the target scheme's own legality check. It has a real job rather than
// duplicating load-time validation: a context rule fires only for some
// neighbours, so its rewrite cannot be proven safe when the file is read.
func (a *Adapter) legal(onset, rime, tone string) string {
	switch {
	case rime == "" || !a.Canonical.rimeSet()[rime]:
		return "rime:" + rime
	case !a.Canonical.toneSet()[tone]:
		return "tone:" + tone
	case onset != "" && !a.Canonical.onsetSet()[onset]:
		return "onset:" + onset
	}
	return ""
}

// parse splits a pronunciation into syllables with longest-first matching, and
// refuses rather than guessing: a digit run that is not exactly one legal tone
// value means letters were lost upstream, which the mapping stage cannot repair.
func (a *Adapter) parse(value string) ([]syllable, bool) {
	return splitSyllables(value, a.sourceOnsets, a.sourceRimes, a.sourceTones)
}

// parseCanonical answers the same question of the target scheme. It exists
// because the exception table is looked up before the pipeline runs: this is the
// only place that can tell a hand-transcribed value from a typo.
func (a *Adapter) parseCanonical(value string) ([]syllable, bool) {
	return splitSyllables(value, a.canonicalOnsets, a.canonicalRimes, a.canonicalTones)
}

func splitSyllables(value string, onsets, rimes, tones []string) ([]syllable, bool) {
	var out []syllable
	rest := value
	for rest != "" {
		onset := longestPrefix(rest, onsets)
		rest = rest[len(onset):]
		rime := longestPrefix(rest, rimes)
		if rime == "" {
			return nil, false
		}
		rest = rest[len(rime):]
		digits := leadingDigits(rest)
		tone := longestPrefix(digits, tones)
		if tone == "" || tone != digits {
			return nil, false
		}
		rest = rest[len(tone):]
		out = append(out, syllable{onset: onset, rime: rime, tone: tone})
	}
	return out, len(out) > 0
}

func leadingDigits(value string) string {
	end := 0
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	return value[:end]
}

func longestPrefix(value string, options []string) string {
	for _, option := range options { // pre-sorted longest first
		if option != "" && strings.HasPrefix(value, option) {
			return option
		}
	}
	return ""
}
