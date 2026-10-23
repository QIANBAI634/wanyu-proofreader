// import_jobs 增加 skipped_count，把 bundle 导入「复用自然键而跳过」的条数落成字段。
//
// bundle 的「成功处理」契约里，复用已有自然键的条目既计 success 又不新建页（见
// bundle_import.go 的 skipped 累计）；此前这个数只写进 error_message 的说明文字，
// 台账无法单独展示「跳过」数。这里新增一个可选整数字段保存它，CSV 导入不写（默认 0）。
//
// 回滚：down() 删除该字段，历史值一起丢掉（仅台账展示用，无外键依赖）。
// 幂等：字段已存在时跳过。

migrate((app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  if (!jobs.fields.getByName("skipped_count")) {
    jobs.fields.add(new NumberField({ name: "skipped_count", onlyInt: true, min: 0 }))
    app.save(jobs)
  }
}, (app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  if (jobs.fields.getByName("skipped_count")) {
    jobs.fields.removeByName("skipped_count")
    app.save(jobs)
  }
})
