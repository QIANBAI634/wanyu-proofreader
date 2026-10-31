// pages 增加 missing_glyph 布尔字段：记录「本条目当前内容里含缺字占位符 @N」的自动状态。
//
// 与 blocked_reason（只有一个人工写入口的结论字段）刻意分开：缺字是能从文本里机械判定的
// 事实，不是人下的结论；自动写成 blocked_reason 会污染难度推导里「人工结论优先」的口径，
// 也会被 #347 的 D 工序当成硬排除理由。因此这里用独立字段存自动状态，随内容在提交时清除。
//
// 历史回填：迁移时按同一 @[0-9a-fA-F]{4,6} 口径扫描现有 pages 的 ocr_text，命中则置
// missing_glyph=true（覆盖试点批次 01v12hb8upe1cnf 里的 606 条缺字，不重导、不重复建条目）。
//
// 回滚：down() 删除该字段，回填的历史标记一并丢掉（仅派发/计数用，无外键依赖）。
// 幂等：字段已存在时跳过；回填只把 missing_glyph=false 的命中行置 true，重复执行无害。

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  if (!pages.fields.getByName("missing_glyph")) {
    pages.fields.add(new BoolField({ name: "missing_glyph" }))
    app.save(pages)
  }
  const glyphPlaceholder = /@[0-9a-fA-F]{4,6}/
  const candidates = app.findAllRecords("pages", $dbx.exp("ocr_text LIKE '%@%'"))
  for (const row of candidates) {
    if (glyphPlaceholder.test(row.getString("ocr_text") || "")) {
      row.set("missing_glyph", true)
      app.save(row)
    }
  }
}, (app) => {
  const pages = app.findCollectionByNameOrId("pages")
  if (pages.fields.getByName("missing_glyph")) {
    pages.fields.removeByName("missing_glyph")
    app.save(pages)
  }
})
