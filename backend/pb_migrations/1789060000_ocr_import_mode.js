// 为 import_jobs.mode 增加 "ocr" 值，承载 OCR 识别作业类型。
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  const modeField = jobs.fields.find((f) => f.name === "mode")
  if (!modeField.values.includes("ocr")) {
    modeField.values = [...modeField.values, "ocr"]
    app.save(jobs)
  }
}, (app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  const modeField = jobs.fields.find((f) => f.name === "mode")
  modeField.values = modeField.values.filter((v) => v !== "ocr")
  app.save(jobs)
})
