// import_jobs 增加 skipped_count，把 bundle 导入「复用自然键而跳过」的条数落成字段。
//
// bundle 的「成功处理」契约里，复用已有自然键的条目既计 success 又不新建页（见
// bundle_import.go 的 skipped 累计）；此前这个数只写进 error_message 的说明文字，
// 台账无法单独展示「跳过」数。这里新增一个可选整数字段保存它，CSV 导入不写（默认 0）。
//
// 历史回填：迁移前已完成的 bundle 批次，其跳过数只存在于 error_message 那句
// 「已跳过 N 条重复条目」里（bundle_import.go 只在 skipped > 0 时才写这句）。这里把它
// 解析回新字段；没有这句的 bundle 批次确实没有跳过，保持 0。不拿当前页存量反推历史值。
//
// 回滚：down() 删除该字段，历史值一起丢掉（仅台账展示用，无外键依赖）。
// 幂等：字段已存在时跳过；回填只对 error_message 里能确认的批次生效，重复执行无害。

migrate((app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  if (!jobs.fields.getByName("skipped_count")) {
    jobs.fields.add(new NumberField({ name: "skipped_count", onlyInt: true, min: 0 }))
    app.save(jobs)
  }
  const bundles = app.findAllRecords("import_jobs", $dbx.exp('mode = "bundle"'))
  for (const record of bundles) {
    const matched = (record.getString("error_message") || "").match(/已跳过 (\d+) 条重复条目/)
    if (matched) {
      record.set("skipped_count", parseInt(matched[1], 10))
      app.save(record)
    }
  }
}, (app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  if (jobs.fields.getByName("skipped_count")) {
    jobs.fields.removeByName("skipped_count")
    app.save(jobs)
  }
})
