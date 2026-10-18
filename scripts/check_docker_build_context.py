#!/usr/bin/env python3
"""Keep the backend image's build context in step with the Go packages on disk.

`backend/Dockerfile` 的 builder 阶段是**白名单** COPY：只有被列出来的目录才进镜像，
然后 `RUN go test ./...`。本机与 CI 的 Go 构建看的是整个工作树，看不到这个缺口——
只有容器构建会。2026-10-03 上真实发生过一次：`backend/scheme/` 随 #281 进了仓库，
但没人 import 它，所以 `go test ./...` 在镜像里也从没编译到它；等到 #289 第一次 import，
镜像构建立刻报 `package fangji/backend/scheme is not in std`，而本机 80 多个检查全绿。

所以这里把两件事对齐：**磁盘上每个含 .go 的 backend 子目录，都必须在 Dockerfile 里被 COPY**。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'backend'
DOCKERFILE = BACKEND / 'Dockerfile'

# COPY <src>/ ./<dst>/ 形式；`COPY *.go ./` 覆盖的是 backend 根目录的 package main，
# 不参与这里的比对（它没有子目录名）。行尾注释与续行在解析前先去掉。
COPY_RE = re.compile(r'^COPY\s+([^\s]+)\s+\./([^\s]+)\s*$', re.MULTILINE)


def go_package_dirs(backend=BACKEND):
    """磁盘上所有直接含 .go 文件的 backend 子目录（相对 backend/ 的 POSIX 路径）。"""
    found = []
    for path in sorted(backend.rglob('*.go')):
        parent = path.parent
        if parent == backend:
            continue
        found.append(parent.relative_to(backend).as_posix())
    return sorted(set(found))


def copied_dirs(text):
    """Dockerfile 里被 COPY 进镜像的目录（相对 backend/ 的 POSIX 路径）。"""
    stripped = '\n'.join(line.split('#', 1)[0].rstrip() for line in text.splitlines())
    return {match.group(1).rstrip('/') for match in COPY_RE.finditer(stripped)}


def problems(package_dirs, copied):
    missing = [name for name in package_dirs if name not in copied]
    if not missing:
        return []
    return [
        'backend/Dockerfile 没有 COPY 这些含 Go 文件的目录：' + '、'.join(missing)
        + '。镜像里 `go test ./...` 会因为「package fangji/backend/<dir> is not in std」失败，'
          '而本机与 CI 的 Go 构建看不到这个缺口。'
    ]


def main():
    found = problems(go_package_dirs(), copied_dirs(DOCKERFILE.read_text(encoding='utf-8')))
    if found:
        for problem in found:
            print(f'docker build context drift: {problem}', file=sys.stderr)
        return 1
    print(f'PASS: every Go package directory under backend/ is copied into the image ({len(go_package_dirs())} checked)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
