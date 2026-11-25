import assert from "node:assert/strict"
import test from "node:test"
import {
  parseDirectory,
  seedDirectories,
} from "@/lib/server/catalog/discovery/seeds"

const directory = seedDirectories.find((entry) => entry.kind === "teamtailor")!
const header = "provider,token,open_postings,board_url,api_url\n"
const row = (
  url: string,
  token = "acme",
  api = "https://acme.teamtailor.com/jobs.json"
) => `${header}teamtailor,${token},100,${url},${api}\n`

test("Teamtailor directory preserves existing pins and imports tenant hosts as candidates only", () => {
  assert.equal(seedDirectories[3].format, "lastround")
  assert.equal(directory.revision, "01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108")
  assert.equal(
    directory.sha256,
    "ef1c4a35f861ba67740585e8d401cebeb6f47982d350ddbd8047213abfcc3e4e"
  )
  const parsed = parseDirectory(directory, row("https://acme.teamtailor.com/"))
  assert.equal(parsed.rows, 1)
  assert.equal(parsed.distinctSources, 1)
  assert.deepEqual(parsed.candidates, [
    {
      id: "teamtailor:acme.teamtailor.com",
      kind: "teamtailor",
      board: "acme.teamtailor.com",
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "https://acme.teamtailor.com",
    },
  ])
})

test("Teamtailor directory refuses mismatched, custom and unsafe board URLs", () => {
  for (const url of [
    "https://other.teamtailor.com/",
    "https://acme.teamtailor.com.evil.example/",
    "https://careers.acme.com/",
    "http://acme.teamtailor.com/",
    "https://user:pass@acme.teamtailor.com/",
    "https://acme.teamtailor.com:8443/",
    "https://acme.teamtailor.com/jobs/1",
    "https://acme.teamtailor.com/?redirect=https://evil.example",
    "https://acme.teamtailor.com/#fragment",
  ])
    assert.throws(() => parseDirectory(directory, row(url)), /match/)
  for (const token of ["../acme", "acme.evil", "www", "api"])
    assert.throws(() =>
      parseDirectory(directory, row("https://acme.teamtailor.com/", token))
    )
})

test("directory API URLs remain provenance data and cannot select fetch targets", () => {
  const parsed = parseDirectory(
    directory,
    row("https://acme.teamtailor.com/", "acme", "http://127.0.0.1/secrets")
  )
  assert.equal(parsed.candidates[0].evidence_url, "https://acme.teamtailor.com")
  assert.equal(parsed.candidates[0].board, "acme.teamtailor.com")
})

test("Recruitee directory imports observed tenant boards with the existing connector identity", () => {
  const recruitee = seedDirectories.find((entry) => entry.kind === "recruitee")!
  const parsed = parseDirectory(
    recruitee,
    `${header}recruitee,acme,100,https://acme.recruitee.com/,https://acme.recruitee.com/api/offers/\n`
  )
  assert.equal(
    recruitee.sha256,
    "0af6d43fc0645df5239cd804b62a223bb89a190197550cecafa8308366bfddfe"
  )
  assert.equal(parsed.candidates[0].id, "recruitee:acme")
  assert.equal(parsed.candidates[0].historical_checked_at, null)
  assert.equal(parsed.candidates[0].expected_company, null)
  assert.throws(
    () =>
      parseDirectory(
        recruitee,
        `${header}recruitee,acme,100,https://other.recruitee.com/,https://acme.recruitee.com/api/offers/\n`
      ),
    /match/
  )
})
