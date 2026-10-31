// 为 pages.status 增加 "rework" 值：下游退回 A 线、等待资料接入重新处理的条目状态。
//
// 与 rejected（空记录／不适用）和 importing（导入暂存）都不同：rework 是「这条曾被
// 下游校对/仲裁/采用发现有问题，被退回给 A 线重做」。校对领取与大厅计数都要把它
// 当作「不可领取」排除掉，A 线处理完再改回 pending。
//
// 回滚：down() 把 rework 从取值表移除；库里若还有 rework 状态的条目会因值不在取值表
// 而在下次校验报错，所以回滚前应先处理掉这些条目（这与其它取值迁移一致）。
// 幂等：值已存在时跳过。

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  const status = pages.fields.find((f) => f.name === "status")
  if (!status.values.includes("rework")) {
    status.values = [...status.values, "rework"]
    app.save(pages)
  }
}, (app) => {
  const pages = app.findCollectionByNameOrId("pages")
  const status = pages.fields.find((f) => f.name === "status")
  status.values = status.values.filter((v) => v !== "rework")
  app.save(pages)
})
