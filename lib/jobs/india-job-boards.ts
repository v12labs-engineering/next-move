export const indiaJobBoards = {
  himalayas: {
    name: "Himalayas",
    url: "https://himalayas.app/",
    dateLabel: "Updated",
  },
  jobicy: { name: "Jobicy", url: "https://jobicy.com/jobs" },
  "remote-ok": { name: "Remote OK", url: "https://remoteok.com/" },
  "remote-backend-jobs": {
    name: "Remote Backend Jobs",
    url: "https://www.remotebackendjobs.com/",
  },
  "remote-frontend-jobs": {
    name: "Remote Frontend Jobs",
    url: "https://www.remotefrontendjobs.com/",
  },
  "remote-java-jobs": {
    name: "Remote Java Jobs",
    url: "https://www.remotejavajobs.com/",
  },
  "we-work-remotely": {
    name: "We Work Remotely",
    url: "https://weworkremotely.com/",
  },
  hasjob: { name: "Hasjob", url: "https://hasjob.co/" },
  shipmates: {
    name: "Shipmates",
    url: "https://heyshipmates.com/jobs?country=in",
    dateLabel: "Listed",
  },
  e2ehiring: {
    name: "e2eHiring",
    url: "https://www.e2ehiring.com/jobs?sort=newest",
  },
  technopark: {
    name: "Technopark",
    url: "https://technopark.in/job-search?lang=e",
  },
  cyberpark: {
    name: "Cyberpark Kozhikode",
    url: "https://cyberparks.in/careers/",
  },
  egig: { name: "eGig", url: "https://egig.in/jobs" },
  "foss-united": {
    name: "FOSS United",
    url: "https://fossunited.org/jobs",
  },
  shine: { name: "Shine", url: "https://www.shine.com/" },
  freshersworld: {
    name: "Freshersworld",
    url: "https://www.freshersworld.com/",
  },
  cutshort: { name: "Cutshort", url: "https://cutshort.io/" },
  apna: { name: "apna", url: "https://apna.co/" },
  "4dayweek": { name: "4 Day Week", url: "https://4dayweek.io/" },
  hirist: { name: "Hirist", url: "https://www.hirist.tech/" },
  iimjobs: { name: "iimjobs", url: "https://www.iimjobs.com/" },
  placementindia: {
    name: "PlacementIndia",
    url: "https://www.placementindia.com/",
  },
  internshala: { name: "Internshala", url: "https://internshala.com/jobs/" },
  talent: { name: "Talent.com", url: "https://in.talent.com/" },
  unstop: { name: "Unstop", url: "https://unstop.com/jobs" },
  remoterocketship: {
    name: "Remote Rocketship",
    url: "https://www.remoterocketship.com/country/india",
  },
  "remoterocketship-global": {
    name: "Remote Rocketship Global",
    url: "https://www.remoterocketship.com/",
  },
  bebee: { name: "beBee", url: "https://bebee.com/in/jobs" },
  indgovtjobs: { name: "IndGovtJobs", url: "https://www.indgovtjobs.in/" },
  herkey: { name: "HerKey", url: "https://www.herkey.com/jobs" },
  nodesk: { name: "NoDesk", url: "https://nodesk.co/remote-jobs/" },
  findwork: { name: "Findwork", url: "https://findwork.dev/" },
  jobspresso: { name: "Jobspresso", url: "https://jobspresso.co/" },
  "hn-hiring": {
    name: "Hacker News Who is hiring",
    url: "https://news.ycombinator.com/submitted?id=whoishiring",
  },
} satisfies Record<string, { name: string; url: string; dateLabel?: string }>

export type IndiaJobBoard = keyof typeof indiaJobBoards

export function isIndiaJobBoard(board: string | null): board is IndiaJobBoard {
  return board !== null && Object.hasOwn(indiaJobBoards, board)
}

export function indiaJobBoardCredit(source: string, jobUrl: string) {
  const board = source.startsWith("indiaboard:") ? source.slice(11) : null
  if (!isIndiaJobBoard(board)) return null
  const credit: { name: string; url: string; dateLabel?: string } =
    indiaJobBoards[board]
  return {
    name: credit.name,
    url: board === "himalayas" || board === "4dayweek" ? credit.url : jobUrl,
    dateLabel: credit.dateLabel ?? "Posted",
  }
}
