// OCR 作业不携带源文件，将 import_jobs.source_file（file）改为可选。
// CSV 导入仍会在代码中显式传入文件，行为不变。
// file_hash/file_size 由 1789062000 迁移改为可选。
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  const field = jobs.fields.find((f) => f.name === "source_file")
  if (field) {
    field.required = false
  }
  app.save(jobs)
}, (app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  const field = jobs.fields.find((f) => f.name === "source_file")
  if (field) {
    field.required = true
  }
  app.save(jobs)
})
