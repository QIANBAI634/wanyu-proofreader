// #240：`blocked_reason` 从此只有一个人工写入口，写的是"谁的结论、什么时候、依据什么"。
//
// 为什么把 who/when/basis 放在 pages 上而不是另开一张审计表：这个字段只有一个值、
// 只被覆盖、且读它的人就是写它的人（平台管理员）。开一张历史表会制造第二个真相源——
// 想知道"现在这条被标成什么"得去 join，而 join 出来的还可能比 pages 上的旧。
// 需要完整变更历史时再开表，别提前设计。
//
// `blocked_reason` 本身已由 #180 建好（SelectField，值域就是 BLOCKED_BUCKETS），
// 这里只补三个审计字段，全部可空：**空串 = 没人说过**，与 "unknown"（看过但认不出）
// 是两件事，这个区分是 #240 验收第 6 条要逐字段断言的东西。
const added = [
  { build: () => new TextField({ name: "blocked_reason_by", required: false }),
    remove: "blocked_reason_by" },
  { build: () => new TextField({ name: "blocked_reason_at", required: false }),
    remove: "blocked_reason_at" },
  { build: () => new TextField({ name: "blocked_reason_note", required: false }),
    remove: "blocked_reason_note" }
]

function hasField(pages, name) {
  return Boolean(pages.fields.getByName(name))
}

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  for (const field of added) {
    if (hasField(pages, field.build().name)) continue
    pages.fields.add(field.build())
  }
  app.save(pages)
}, (app) => {
  const pages = app.findCollectionByNameOrId("pages")
  for (const field of added) {
    if (hasField(pages, field.remove)) pages.fields.removeByName(field.remove)
  }
  app.save(pages)
})
