// 为 proofreading_attempts.outcome 增加 "superseded" 值：返工退回时，旧轮里尚未达到
// 双人 quorum 的 waiting attempt 不再参与新的校对轮。它既不是「一致」也不是「不一致」，
// 不能计入 /proofreader-stats 的一致率分母（B8.2：未达人数要求的尝试不进分母），
// 但记录要保留用于审计，所以单独给一个失效状态。
//
// 回滚：down() 把 superseded 从取值表移除；库里若还有该状态的 attempt，回滚前应先处理
// 掉这些记录（与其它取值迁移一致）。
// 幂等：值已存在时跳过。

migrate((app) => {
  const attempts = app.findCollectionByNameOrId("proofreading_attempts")
  const outcome = attempts.fields.find((f) => f.name === "outcome")
  if (!outcome.values.includes("superseded")) {
    outcome.values = [...outcome.values, "superseded"]
    app.save(attempts)
  }
}, (app) => {
  const attempts = app.findCollectionByNameOrId("proofreading_attempts")
  const outcome = attempts.fields.find((f) => f.name === "outcome")
  outcome.values = outcome.values.filter((v) => v !== "superseded")
  app.save(attempts)
})
