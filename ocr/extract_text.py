#!/usr/bin/env python3
"""
extract_text.py — 从数字原生 PDF 提取文本层（#120 选型参考的第一步）

数字原生 PDF 自带文本层，可直接提取精确的 Unicode 文本与坐标，不需要图像 OCR。
这是 OCR 链路上性价比最高的一步：先判断 PDF 是否数字原生，若是则走文本层提取。

依赖：系统安装 pdftotext（poppler-utils）。

用法：
    python extract_text.py --pdf 输入.pdf --out 输出.txt [--first 1 --last 3]

说明：
    - 输出为纯文本（保留 -layout 的版面信息）
    - 若 PDF 是扫描版（无文本层），输出会接近空白，此时才需要图像 OCR
"""

import argparse
import subprocess
import sys
import shutil
from pathlib import Path


def find_pdftotext():
    """定位 pdftotext 可执行文件，返回命令（字符串或路径）。"""
    # 1. 优先用 PATH 里的
    found = shutil.which("pdftotext")
    if found:
        return "pdftotext"
    # 2. 常见安装位置（Git for Windows 自带 poppler）
    candidates = [
        Path(r"D:\Git\mingw64\bin\pdftotext.exe"),
        Path(r"C:\Program Files\Git\mingw64\bin\pdftotext.exe"),
        Path(r"C:\Program Files\Git\usr\bin\pdftotext.exe"),
        Path(r"C:\Program Files\poppler\bin\pdftotext.exe"),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def extract_text(pdf_path, first=1, last=None, layout=True):
    """调用 pdftotext 提取文本层，返回字符串。"""
    pdftotext = find_pdftotext()
    if pdftotext is None:
        raise RuntimeError(
            "未找到 pdftotext。请安装 poppler-utils，或把 pdftotext 加入 PATH。"
        )
    cmd = [pdftotext]
    if layout:
        cmd.append("-layout")
    cmd.extend(["-f", str(first)])
    if last is not None:
        cmd.extend(["-l", str(last)])
    cmd.extend([str(pdf_path), "-"])
    # pdftotext 在 Windows 上默认按系统编码输出（可能是 GBK），用字节模式捕获后按 utf-8/GBK 回退解码
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"pdftotext 失败: {result.stderr.decode('utf-8', errors='replace')}")
    raw = result.stdout
    for enc in ("utf-8", "gbk", "utf-16"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description="提取数字原生 PDF 文本层")
    parser.add_argument("--pdf", required=True, help="PDF 文件路径")
    parser.add_argument("--out", help="输出 txt 路径（缺省打印到屏幕）")
    parser.add_argument("--first", type=int, default=1, help="起始页")
    parser.add_argument("--last", type=int, default=None, help="结束页（缺省到最后一页）")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.is_file():
        print(f"错误：PDF 不存在 {pdf_path}", file=sys.stderr)
        sys.exit(1)

    text = extract_text(pdf_path, first=args.first, last=args.last)

    if args.out:
        out_path = Path(args.out)
        out_path.write_text(text, encoding="utf-8")
        print(f"已写出 {out_path}（{len(text)} 字符）")
    else:
        print(text)


if __name__ == "__main__":
    main()
