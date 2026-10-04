"""Regression fixtures exercise positive detections, false positives and exits."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import check_ui_debt as guard


class UiDebtTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'src'
        self.source.mkdir()

    def write(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def baseline(self, limits=None, modes=None):
        data = {'version': 1, 'kinds': {
            kind: {'limit': (limits or {}).get(kind, 0), 'mode': (modes or {}).get(kind, 'warn')}
            for kind in guard.KINDS}}
        path = self.root / 'baseline.json'
        path.write_text(json.dumps(data), encoding='utf-8')
        return path

    def run_guard(self, baseline, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = guard.main(['--source-root', str(self.source), '--baseline', str(baseline), *args])
        return code, out.getvalue()

    def test_colors_are_property_values_not_comments_selectors_or_prefixes(self):
        self.write('Example.vue', '''<template><a href="#fff">#fff</a></template>
<script>const fake = 'color: #fff'; // #123456</script>
<style>
/* #234 #161 color: #123456; */
#fff { color: #fff; background: #fff7ed; content: "#fff; /* #123456 */";
  mask: url("icon.svg#fff"); border: 1px solid rgba(0, 0, 0, .2); }
</style>''')
        rows = guard.measure(self.source)['hardcoded_colors']
        self.assertEqual([r['value'] for r in rows], ['#fff', '#fff7ed', 'rgba(0, 0, 0, .2)'])
        self.assertEqual([r['line'] for r in rows], [5, 5, 6])
        self.write('Example.vue', '<style>/* color: #fff; */ .x { color: var(--ink); }</style>')
        self.assertEqual(guard.measure(self.source)['hardcoded_colors'], [])

    def test_all_nine_kinds_and_multiline_tag_locations(self):
        self.write('View.vue', '''<template>
<!-- <table class="alert modal-backdrop" style="color:#123456"> -->
<table
 class="extra alert modal-backdrop"
 style="color: #fff; border-radius: 4px; z-index: 9">
</table>
<div class="alert"
 role="status">OK</div>
<div :class="{ alert: false }" role="status"></div>
</template>
<style>.x { border-radius: 4px; z-index: 9; color: var(--missing, #fff);
 font-family: 'A', sans-serif; }</style>''')
        found = guard.measure(self.source)
        self.assertEqual(guard.counts(found), {
            'hardcoded_colors': 2, 'border_radius_literals': 1, 'z_index_literals': 1,
            'inline_styles': 1, 'bare_tables': 1, 'alerts_without_role': 1,
            'custom_modals': 1, 'undefined_variables': 1, 'font_family_stacks': 1})
        self.assertEqual(found['alerts_without_role'][0]['line'], 3)
        self.assertEqual(found['undefined_variables'][0]['line'], 11)

    def test_tokens_shared_modal_and_font_face_are_permitted(self):
        self.write('tokens.css', '''/* var(--comment) */
:root { --ink: #fff; --surface: var(--ink); --radius: 4px; --shadow: rgba(0,0,0,.5); }
@font-face { font-family: "A"; src: url(a.woff2); }
.x { color: var(--surface); border-radius: var(--radius); font-family: inherit; }''')
        self.write('components/AppModal.vue', '<template><div class="modal-backdrop"></div></template>')
        self.assertEqual(guard.counts(guard.measure(self.source)), dict.fromkeys(guard.KINDS, 0))

    def test_bound_constant_style_and_runtime_custom_property(self):
        self.write('View.vue', '''<template>
<div :style="{ color: '#fff', borderRadius: '5px', '--completion': progress }"></div>
<div v-bind:style="{ width: progress + '%' }"></div>
<div :class="['alert', variant]" :role="statusRole"></div>
</template><style>.x { width: var(--completion); }</style>''')
        found = guard.measure(self.source)
        self.assertEqual(found['hardcoded_colors'][0]['value'], '#fff')
        self.assertEqual(found['hardcoded_colors'][0]['line'], 2)
        self.assertEqual(found['border_radius_literals'][0]['value'], '5px')
        self.assertEqual(len(found['inline_styles']), 2)
        self.assertEqual(found['undefined_variables'], [])
        self.assertEqual(found['alerts_without_role'], [])

    def test_warning_then_strict_failure_then_removal_passes(self):
        self.write('View.vue', '<style>.x { color: #fff; }</style>')
        baseline = self.baseline()
        code, output = self.run_guard(baseline)
        self.assertEqual(code, 0)
        self.assertIn('hardcoded_colors / 0 / 1 / +1 / warn / WARN', output)
        self.assertIn('frontend/src/View.vue:1', output)
        self.assertEqual(sum(line.startswith(tuple(guard.KINDS)) for line in output.splitlines()), 9)
        code, output = self.run_guard(baseline, '--mode', 'fail')
        self.assertEqual(code, 1)
        self.assertIn('FAIL: UI debt increased', output)
        self.write('View.vue', '<style>.x { color: inherit; }</style>')
        self.assertEqual(self.run_guard(baseline, '--mode', 'fail')[0], 0)

    def test_selected_category_can_fail_without_promoting_other_warnings(self):
        self.write('View.vue', '<template><table></table></template><style>.x { color: #fff; }</style>')
        baseline = self.baseline(modes={'bare_tables': 'fail'})
        self.assertEqual(self.run_guard(baseline)[0], 1)
        code, output = self.run_guard(baseline, '--only', 'hardcoded_colors')
        self.assertEqual(code, 0)
        self.assertNotIn('bare_tables /', output)
        self.assertEqual(self.run_guard(baseline, '--only', 'bare_tables')[0], 1)

    def test_equal_and_reduced_counts_pass_in_fail_mode(self):
        self.write('View.vue', '<style>.x { color: #fff; background: #fff; }</style>')
        baseline = self.baseline(limits={'hardcoded_colors': 2})
        self.assertEqual(self.run_guard(baseline, '--mode', 'fail')[0], 0)
        self.write('View.vue', '<style>.x { color: #fff; }</style>')
        code, output = self.run_guard(baseline, '--mode', 'fail')
        self.assertEqual(code, 0)
        self.assertIn('/ 2 / 1 / -1 / fail / PASS', output)

    def test_missing_source_and_invalid_baseline_do_not_silently_pass(self):
        baseline = self.baseline()
        self.assertEqual(self.run_guard(baseline)[0], 1)
        self.write('View.vue', '<template></template>')
        baseline.write_text('{"version": 1, "kinds": {}}', encoding='utf-8')
        self.assertEqual(self.run_guard(baseline)[0], 1)
        baseline.write_text('{broken', encoding='utf-8')
        self.assertEqual(self.run_guard(baseline)[0], 1)

    def test_named_colors_and_comment_like_strings(self):
        self.write('style.css', '''.x { color: white; border: 1px solid rebeccapurple;
 content: "/* #fff */"; color: var(--white); background: var(--surface, white); }
 :root { --white: #fff; }''')
        self.assertEqual([r['value'] for r in guard.measure(self.source)['hardcoded_colors']],
                         ['white', 'rebeccapurple', 'white'])

    def test_bound_alert_class_and_empty_role_are_detected(self):
        self.write('View.vue', '''<template>
<div :class="{ alert: error }" role=""></div>
<div v-bind:class="['alert', variant]"></div>
<div class="alerting"></div>
</template>''')
        self.assertEqual([r['line'] for r in guard.measure(self.source)['alerts_without_role']], [2, 3])


if __name__ == '__main__':
    unittest.main()
