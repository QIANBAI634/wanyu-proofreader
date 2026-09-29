function currentRound(page) {
  return page.getInt("proofread_round") || 1
}

function proofreadAttempts(dao, page) {
  const round = currentRound(page)
  return dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && kind = "proofread"`,
    "pass_no,created",
    1000,
    0
  )
}

function ownProofreadAttempt(dao, page, userId) {
  const round = currentRound(page)
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && proofreader = "${userId}" && kind = "proofread"`,
    "",
    1,
    0
  )
  return attempts.length ? attempts[0] : null
}

function reviewedProofreads(dao, projectId, userId) {
  const pages = dao.findRecordsByFilter(
    "pages",
    `project = "${projectId}"`,
    "page_number",
    100000,
    0
  )
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `project = "${projectId}" && proofreader = "${userId}" && kind = "proofread"`,
    "",
    100000,
    0
  )
  const attemptsByPage = Object.create(null)
  for (const attempt of attempts) {
    const pageId = attempt.getString("page")
    if (!attemptsByPage[pageId]) attemptsByPage[pageId] = []
    attemptsByPage[pageId].push(attempt)
  }
  const items = []
  for (const page of pages) {
    if (page.getString("project") !== projectId) continue
    const round = currentRound(page)
    const attempt = (attemptsByPage[page.id] || []).find((row) => row.getInt("round") === round)
    if (!attempt) continue
    items.push({ page, attempt })
  }
  items.sort((a, b) => {
    const byNumber = a.page.getInt("page_number") - b.page.getInt("page_number")
    if (byNumber !== 0) return byNumber
    return String(a.page.id).localeCompare(String(b.page.id))
  })
  return items
}

function arbitrationAttempt(dao, page) {
  const round = currentRound(page)
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && kind = "arbitration"`,
    "created",
    1,
    0
  )
  return attempts.length ? attempts[0] : null
}

function requiredProofreads(dao, projectId) {
  const project = dao.findRecordById("projects", projectId)
  return Math.max(2, project.getInt("required_proofreads") || 2)
}

// Precomposed and decomposed spellings of the same reading are the same reading.
// This corpus is full of nasalised vowels with combining tildes, and U+00E3 (ã)
// versus a + U+0303 render identically while differing in bytes, so raw string
// comparison reported two proofreaders as disagreeing when no one could see a
// difference. That false divergence went straight into arbitration and counted
// against the proofreaders' accuracy, because it spends the scarcest resource
// in the project on a difference that does not exist.
//
// NFC only, never NFKC. NFKC goes further and folds compatibility forms —
// fullwidth Ａ to A, superscript ² to 2 and ʰ to h, the ﬁ ligature to fi — which
// would erase distinctions this project deliberately keeps. That is a worse
// error than the one being fixed here, so the direction is pinned by a test.
//
// Reading those tests: ɑ (U+0251) and Ǿ (U+01FE) survive NFKC unchanged, so a
// pair like ɑ/a cannot tell the two forms apart and stays green under an NFKC
// implementation. Only a pair NFKC really folds can pin this direction.
//
// This is a comparison key, never a write-back: an attempt's row_json keeps the
// exact codepoints its proofreader typed.
function normalizeNFC(value) {
  // goja implements String.prototype.normalize with a real NFC branch, so this
  // needs no Go-side comparison rewrite and no new dependency. A probe test
  // pins it: swapping the JSVM for one without it would silently turn this into
  // the identity function and bring the false divergences straight back.
  return String(value ?? "").normalize("NFC")
}

function canonicalRow(raw) {
  let parsed = null
  try { parsed = JSON.parse(String(raw || "")) } catch { return normalizeNFC(raw) }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return normalizeNFC(raw)
  // Keys are normalised too, but looked up under their original spelling: two
  // spellings of one column name are one column.
  const entries = Object.keys(parsed)
    .map((key) => [normalizeNFC(key), String(parsed[key] ?? "").trim()])
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
  const result = {}
  for (const [key, value] of entries) result[key] = normalizeNFC(value)
  return JSON.stringify(result)
}

function setAttemptOutcomes(dao, attempts, outcome) {
  for (const attempt of attempts) {
    if (attempt.getString("outcome") === outcome) continue
    attempt.set("outcome", outcome)
    dao.save(attempt)
  }
}

function resetPageForMoreProofreads(dao, page, attempts) {
  const { clearLease } = require(`${__hooks}/lib/task_leases.js`)
  page.set("proofread_count", attempts.length)
  page.set("proofread_row_json", "")
  page.set("proofread_text", "")
  page.set("proofreader", null)
  page.set("status", attempts.length ? "proofread" : "pending")
  clearLease(dao, page)
  setAttemptOutcomes(dao, attempts, "waiting")
  dao.save(page)
  return { status: page.getString("status"), count: attempts.length, outcome: "waiting" }
}

function evaluatePage(dao, page) {
  const { clearLease } = require(`${__hooks}/lib/task_leases.js`)
  const attempts = proofreadAttempts(dao, page)
  const required = requiredProofreads(dao, page.getString("project"))
  page.set("proofread_count", attempts.length)
  if (attempts.length < required) return resetPageForMoreProofreads(dao, page, attempts)

  const values = attempts.map((attempt) => canonicalRow(attempt.getString("row_json")))
  const matched = values.every((value) => value === values[0])
  page.set("proofreader", null)
  clearLease(dao, page)
  if (matched) {
    const source = attempts[0]
    page.set("proofread_row_json", source.getString("row_json"))
    page.set("proofread_text", source.getString("text"))
    page.set("proofread_at", String(source.get("submitted_at") || new Date().toISOString()))
    page.set("status", "approved")
    setAttemptOutcomes(dao, attempts, "matched")
    dao.save(page)
    return { status: "approved", count: attempts.length, outcome: "matched" }
  }

  const alreadyMismatched = attempts.some((attempt) => attempt.getString("outcome") === "mismatched")
  page.set("proofread_row_json", "")
  page.set("proofread_text", "")
  page.set("status", "arbitration")
  if (!alreadyMismatched) {
    page.set("mismatch_count", page.getInt("mismatch_count") + 1)
    page.set("last_mismatch_at", new Date().toISOString())
  }
  setAttemptOutcomes(dao, attempts, "mismatched")
  dao.save(page)
  return { status: "arbitration", count: attempts.length, outcome: "mismatched" }
}

function reconcileProjectQuorum(dao, projectId) {
  const { leaseForPage, leaseExpired, clearLease } = require(`${__hooks}/lib/task_leases.js`)
  const pages = dao.findRecordsByFilter("pages", `project = "${projectId}"`, "page_number", 100000, 0)
  const required = requiredProofreads(dao, projectId)
  for (const page of pages) {
    if (arbitrationAttempt(dao, page)) continue
    if (page.getString("status") === "arbitration") continue
    const attempts = proofreadAttempts(dao, page)
    page.set("proofread_count", attempts.length)
    const active = ["claimed", "proofreading"].includes(page.getString("status"))
    if (active) {
      const lease = leaseForPage(dao, page.id)
      if (lease && !leaseExpired(lease)) {
        dao.save(page)
        continue
      }
      clearLease(dao, page)
    }
    if (attempts.length >= required) evaluatePage(dao, page)
    else if (page.getString("status") === "approved" || active) resetPageForMoreProofreads(dao, page, attempts)
    else dao.save(page)
  }
}

module.exports = {
  proofreadAttempts,
  ownProofreadAttempt,
  reviewedProofreads,
  arbitrationAttempt,
  requiredProofreads,
  canonicalRow,
  evaluatePage,
  reconcileProjectQuorum
}
