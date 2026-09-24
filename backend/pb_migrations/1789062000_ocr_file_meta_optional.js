// OCR 作业无源文件，file_hash/file_size 对 OCR 无意义，改为可选。
// （source_file 已在 1789061000 迁移中改为可选。）
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  for (const name of ["file_hash", "file_size"]) {
    const field = jobs.fields.find((f) => f.name === name)
    if (field) {
      field.required = false
    }
  }
  app.save(jobs)
}, (app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  for (const name of ["file_hash", "file_size"]) {
    const field = jobs.fields.find((f) => f.name === name)
    if (field) {
      field.required = true
    }
  }
  app.save(jobs)
})
