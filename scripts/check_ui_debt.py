#!/usr/bin/env python3
"""Measure UI debt without third-party parsers; local and CI use this entry point.

This is a source convention guard, not a CSS/Vue compiler. It reads CSS, Vue
style blocks and literal style attributes, and parses template opening tags.
Runtime-generated styles/classes and external CSS are outside its coverage.
Offsets survive comment masking, so every finding points to the source line.
"""
import argparse
from collections import Counter
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
KINDS = (
    'hardcoded_colors', 'border_radius_literals', 'z_index_literals',
    'inline_styles', 'bare_tables', 'alerts_without_role', 'custom_modals',
    'undefined_variables', 'font_family_stacks',
)
DISTINCT = {'border_radius_literals', 'z_index_literals'}
BLOCKS = re.compile(r'<(script|style)\b[^>]*>(.*?)</\1\s*>', re.S | re.I)
HEX = re.compile(r'#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])', re.I)
FUNCTION_COLOR = re.compile(r'\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)', re.I)
VAR = re.compile(r'var\(\s*(--[\w-]+)')
NAMED_COLORS = set('''aliceblue antiquewhite aqua aquamarine azure beige bisque black
blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen
darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia
gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink
indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite
navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell
sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'''.split())


def blank(match):
    return ''.join('\n' if c == '\n' else ' ' for c in match.group())


def mask_comments(text):
    # Quoted CSS strings (including URLs) are not comments.
    return re.sub(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|/\*.*?\*/|<!--.*?-->''',
                  lambda m: blank(m) if m.group().startswith(('/*', '<!--')) else m.group(),
                  text, flags=re.S)


def declarations(text):
    """Yield property, value and source offset; respect strings and functions."""
    start, depth, quote, escaped = 0, 0, None, False
    for i, char in enumerate(text + ';'):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in '\"\'':
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth = max(0, depth - 1)
        elif not depth and char in ';{}':
            if char != '{':
                part = text[start:i]
                match = re.match(r'\s*(--[\w-]+|[a-zA-Z][\w-]*)\s*:\s*(.*)', part, re.S)
                if match:
                    yield match[1], match[2], start + match.start(2)
            start = i + 1


class TemplateParser(HTMLParser):
    def __init__(self, text, record, css, define):
        super().__init__(convert_charrefs=False)
        self.text, self.record, self.css, self.define = text, record, css, define
        self.lines = [0] + [m.end() for m in re.finditer('\n', text)]

    def handle_starttag(self, tag, attrs):
        offset = self.lines[self.getpos()[0] - 1] + self.getpos()[1]
        attrs = dict(attrs)
        classes = set((attrs.get('class') or '').split())
        # Literal class names in a bound expression are visible, too.
        for name in (':class', 'v-bind:class'):
            expression = attrs.get(name) or ''
            for literal in re.findall(r'''["']([^"']+)["']''', expression):
                classes.update(literal.split())
            classes.update(re.findall(r'(?:\{|,)\s*([\w-]+)\s*:', expression))
        if tag == 'table':
            self.record('bare_tables', offset, 'table')
        if 'alert' in classes and not any(attrs.get(k) for k in ('role', ':role', 'v-bind:role')):
            self.record('alerts_without_role', offset, 'alert')
        if 'modal-backdrop' in classes:
            self.record('custom_modals', offset, 'modal-backdrop')
        for name in ('style', ':style', 'v-bind:style'):
            if name not in attrs:
                continue
            self.record('inline_styles', offset, name)
            # Use the original attribute value so its offset/line is exact.
            match = re.search(r'''(?<![\w:-])''' + re.escape(name) + r'''\s*=\s*(["'])(.*?)\1''',
                              self.get_starttag_text(), re.S)
            if not match:
                continue
            value, pos = match[2], offset + match.start(2)
            if name == 'style':
                self.css(mask_comments(value), pos)
            else:
                # Vue object style keys can define custom properties at runtime.
                for key in re.findall(r'''["'](--[\w-]+)["']\s*:''', value):
                    self.define(key)
                # Recognize constant object values; variable/computed values are
                # deliberately left to the Vue compiler and runtime.
                for literal in re.finditer(r'''(?:["']([\w-]+)["']|\b([a-zA-Z][\w-]*))\s*:\s*(["'])(.*?)\3''', value, re.S):
                    prop = literal[1] or literal[2]
                    prop = re.sub(r'[A-Z]', lambda m: '-' + m[0].lower(), prop)
                    # Prefix preserves the value's offset without fabricating lines.
                    self.css(prop + ':' + mask_comments(literal[4]),
                             pos + literal.start(4) - len(prop) - 1)

    handle_startendtag = handle_starttag


def measure(source_root):
    found = {kind: [] for kind in KINDS}
    defined, references = set(), []
    paths = sorted(p for p in source_root.rglob('*') if p.suffix in {'.css', '.vue'})
    if not paths:
        raise ValueError(f'no CSS/Vue sources under {source_root}')
    for path in paths:
        text = path.read_text(encoding='utf-8')
        relative = 'frontend/src/' + path.relative_to(source_root).as_posix()

        def record(kind, offset, value):
            if kind == 'custom_modals' and relative == 'frontend/src/components/AppModal.vue':
                return
            found[kind].append({'file': relative, 'line': text.count('\n', 0, offset) + 1, 'value': value})

        def css(content, base=0):
            for prop, value, pos in declarations(content):
                offset = base + pos
                if prop.startswith('--'):
                    defined.add(prop)
                for match in VAR.finditer(value):
                    references.append((match[1], relative, text.count('\n', 0, offset + match.start()) + 1))
                if prop.startswith('--'):
                    # Token definitions are the permitted home for literals.
                    continue
                # Neither CSS content strings nor URL fragments are colors.
                color_value = re.sub(r'''url\((?:[^()"']|"[^"]*"|'[^']*')*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*' '''.strip(),
                                     blank, value, flags=re.I)
                for pattern in (HEX, FUNCTION_COLOR):
                    for match in pattern.finditer(color_value):
                        record('hardcoded_colors', offset + match.start(), match[0].lower())
                if prop.lower() in {'color', 'background', 'background-color', 'border', 'box-shadow',
                                    'text-shadow', 'fill', 'stroke', 'outline', 'outline-color'} or prop.lower().startswith('border-'):
                    # Mask token names but keep fallbacks such as var(--x, white).
                    names = re.sub(r'--[\w-]+', blank, color_value)
                    for match in re.finditer(r'\b[a-zA-Z]+\b', names):
                        if match[0].lower() in NAMED_COLORS:
                            record('hardcoded_colors', offset + match.start(), match[0].lower())
                normalized = re.sub(r'\s+', ' ', value.strip()).removesuffix(' !important')
                if prop.lower() in {'border-radius', 'z-index'} and not re.search(r'\b(?:var|env)\(', value):
                    if normalized not in {'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'auto'}:
                        record('border_radius_literals' if prop.lower() == 'border-radius' else 'z_index_literals',
                               offset, normalized)
                # @font-face declarations name a single face, not a copied stack.
                if prop.lower() == 'font-family' and ',' in value and not VAR.search(value):
                    record('font_family_stacks', offset, normalized)

        if path.suffix == '.css':
            css(mask_comments(text))
        else:
            cleaned = re.sub(r'<!--.*?-->', blank, text, flags=re.S)
            for match in BLOCKS.finditer(cleaned):
                if match[1].lower() == 'style':
                    css(mask_comments(match[2]), match.start(2))
            template = BLOCKS.sub(blank, cleaned)
            TemplateParser(template, record, css, defined.add).feed(template)
    for name, file, line in references:
        if name not in defined:
            found['undefined_variables'].append({'file': file, 'line': line, 'value': name})
    return found


def counts(found):
    return {kind: len({r['value'] for r in rows}) if kind in DISTINCT else len(rows)
            for kind, rows in found.items()}


def load_baseline(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(data, dict) or data.get('version') != 1
            or not isinstance(data.get('kinds'), dict) or set(data['kinds']) != set(KINDS)):
        raise ValueError('baseline must use version 1 and contain exactly the nine kinds')
    for kind, policy in data['kinds'].items():
        if (not isinstance(policy, dict) or type(policy.get('limit')) is not int or policy['limit'] < 0
                or policy.get('mode') not in {'warn', 'fail'}):
            raise ValueError(f'invalid limit/mode for {kind}')
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', choices=KINDS, action='append', help='select kind (repeatable)')
    parser.add_argument('--mode', choices=('warn', 'fail'), help='override selected policies; fail for acceptance probes')
    parser.add_argument('--baseline', type=Path, default=ROOT / 'scripts/ui_debt_baseline.json')
    parser.add_argument('--source-root', type=Path, default=ROOT / 'frontend/src', help='fixture source tree')
    args = parser.parse_args(argv)
    try:
        baseline = load_baseline(args.baseline)
        found = measure(args.source_root)
    except (OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    now, failed, warned = counts(found), False, False
    print('kind / baseline / now / delta / mode / result')
    for kind in args.only or KINDS:
        policy = baseline['kinds'][kind]
        delta, mode = now[kind] - policy['limit'], args.mode or policy['mode']
        status = mode.upper() if delta > 0 else 'PASS'
        failed |= delta > 0 and mode == 'fail'
        warned |= delta > 0 and mode == 'warn'
        print(f"{kind} / {policy['limit']} / {now[kind]} / {delta:+d} / {mode} / {status}")
        for row in found[kind]:
            print(f"  {row['file']}:{row['line']}  {row['value']}")
        if kind in {'hardcoded_colors', 'inline_styles', 'font_family_stacks'}:
            print('  values: ' + json.dumps(dict(sorted(Counter(r['value'] for r in found[kind]).items())), ensure_ascii=False))
    print('FAIL: UI debt increased' if failed else 'WARN: UI debt increased (non-blocking)' if warned else 'PASS: UI debt is within baseline')
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
