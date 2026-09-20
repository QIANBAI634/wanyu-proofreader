#!/usr/bin/env python3
"""
score.py — 万语校坊 OCR 验收打分脚本（#120）

对比「参考真值 CSV（标准答案）」与「待测 CSV（OCR 结果）」，输出验收指标。

用法：
    python score.py --gold 标准答案.csv --test 待测结果.csv [--key 页码/行号列]

输入约定：
    - 两份 CSV 列结构一致，按行对齐比较
    - 若未指定 --key，默认按 CSV 行顺序对齐
    - 若指定 --key，按该列的值对齐（如 PDF页码 或 条号）

输出指标（v0.1 先实现核心三项）：
    1. 字级准确率 CER       —— 可读字符的识别正确度
    2. 列归属准确率         —— 每个单元格内容与标准答案完全一致的比例
    3. 行对齐率             —— 待测行数 / 标准行数（衡量漏切/多切）
"""

import argparse
import csv
import sys
from pathlib import Path


def read_csv(path):
    """读取 CSV，返回 (表头列表, 行列表[dict])。"""
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows = [dict(row) for row in reader]
    return fieldnames, rows


def char_error_rate(gold_text, test_text):
    """
    计算字级错误率（CER，越低越好）。
    采用 Levenshtein 编辑距离 / 标准字符串长度。

    返回值：错误率（0.0~1.0，越小越好）
    """
    gold = str(gold_text or "")
    test = str(test_text or "")
    if not gold:
        # 标准答案为空，测试也空则 0 错，否则按测试长度全错
        return 0.0 if not test else 1.0
    distance = levenshtein(gold, test)
    return min(1.0, distance / len(gold))


def levenshtein(a, b):
    """标准 Levenshtein 编辑距离。"""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            insert = curr[-1] + 1
            delete = prev[j] + 1
            replace = prev[j - 1] + (ca != cb)
            curr.append(min(insert, delete, replace))
        prev = curr
    return prev[-1]


def score(gold_rows, test_rows, fields):
    """
    对两份数据逐行逐字段打分。

    返回 dict，包含各项指标。
    """
    n_gold = len(gold_rows)
    n_test = len(test_rows)

    # 行对齐率：测试行数相对标准行数
    row_alignment = n_test / n_gold if n_gold else 0.0

    # 逐行对齐（多退少补）
    n_rows = max(n_gold, n_test)
    total_cells = 0
    matched_cells = 0
    total_chars = 0
    total_char_errors = 0

    for i in range(n_rows):
        gold_row = gold_rows[i] if i < n_gold else {}
        test_row = test_rows[i] if i < n_test else {}
        for field in fields:
            gold_val = gold_row.get(field, "")
            test_val = test_row.get(field, "")
            total_cells += 1
            if str(gold_val or "") == str(test_val or ""):
                matched_cells += 1
            # CER 累加
            total_chars += max(1, len(str(gold_val or "")))
            total_char_errors += int(levenshtein(str(gold_val or ""), str(test_val or "")))

    cell_accuracy = matched_cells / total_cells if total_cells else 0.0
    cer = total_char_errors / total_chars if total_chars else 0.0

    return {
        "标准行数": n_gold,
        "待测行数": n_test,
        "行对齐率": round(row_alignment, 4),
        "列归属准确率": round(cell_accuracy, 4),
        "字级错误率 CER": round(cer, 4),
        "字级准确率": round(1 - cer, 4),
    }


def main():
    parser = argparse.ArgumentParser(description="万语校坊 OCR 验收打分脚本")
    parser.add_argument("--gold", required=True, help="参考真值 CSV（标准答案）")
    parser.add_argument("--test", required=True, help="待测 CSV（OCR 结果）")
    parser.add_argument("--key", default="", help="按该列值对齐（留空则按行顺序）")
    args = parser.parse_args()

    gold_path = Path(args.gold)
    test_path = Path(args.test)
    if not gold_path.is_file():
        print(f"错误：标准答案文件不存在 {gold_path}", file=sys.stderr)
        sys.exit(1)
    if not test_path.is_file():
        print(f"错误：待测文件不存在 {test_path}", file=sys.stderr)
        sys.exit(1)

    gold_fields, gold_rows = read_csv(gold_path)
    test_fields, test_rows = read_csv(test_path)

    # 字段取两份的交集（至少标准答案的字段要都在）
    fields = [f for f in gold_fields if f in test_fields]
    if not fields:
        print("错误：两份 CSV 没有共同的字段", file=sys.stderr)
        sys.exit(1)
    missing = [f for f in gold_fields if f not in test_fields]
    if missing:
        print(f"警告：待测 CSV 缺少字段 {missing}，已跳过", file=sys.stderr)

    result = score(gold_rows, test_rows, fields)

    print("=" * 50)
    print("万语校坊 OCR 打分结果")
    print("=" * 50)
    print(f"标准答案: {gold_path.name} ({len(gold_rows)} 行)")
    print(f"待测结果: {test_path.name} ({len(test_rows)} 行)")
    print(f"比较字段: {', '.join(fields)}")
    print("-" * 50)
    for key, value in result.items():
        print(f"  {key}: {value}")
    print("=" * 50)


if __name__ == "__main__":
    main()
