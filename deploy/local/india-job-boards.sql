-- Reviewed multi-employer sources. Run after 202611190098_india_job_boards.sql.
insert into public.job_source_directory
  (id, kind, board, company, discovered_url, enabled, countries, collection_interval_seconds)
select 'indiaboard:' || board, 'indiaboard', board, company, url, enabled, array['India'], seconds
from (values
  ('himalayas', 'Himalayas', 'https://himalayas.app/', 3600, true),
  ('jobicy', 'Jobicy', 'https://jobicy.com/jobs', 7200, true),
  ('remote-ok', 'Remote OK', 'https://remoteok.com/', 7200, true),
  ('remote-backend-jobs', 'Remote Backend Jobs', 'https://www.remotebackendjobs.com/', 3600, true),
  ('remote-frontend-jobs', 'Remote Frontend Jobs', 'https://www.remotefrontendjobs.com/', 3600, true),
  ('remote-java-jobs', 'Remote Java Jobs', 'https://www.remotejavajobs.com/', 3600, true),
  ('we-work-remotely', 'We Work Remotely', 'https://weworkremotely.com/', 7200, true),
  ('hasjob', 'Hasjob', 'https://hasjob.co/', 7200, true),
  ('shipmates', 'Shipmates', 'https://heyshipmates.com/jobs?country=in', 3600, true),
  ('e2ehiring', 'e2eHiring', 'https://www.e2ehiring.com/jobs?sort=newest', 3600, true),
  ('technopark', 'Technopark', 'https://technopark.in/job-search?lang=e', 3600, true),
  ('cyberpark', 'Cyberpark Kozhikode', 'https://cyberparks.in/careers/', 3600, true),
  ('egig', 'eGig', 'https://egig.in/jobs', 3600, true),
  ('foss-united', 'FOSS United', 'https://fossunited.org/jobs', 3600, true),
  ('4dayweek', '4 Day Week', 'https://4dayweek.io/', 7200, true),
  ('shine', 'Shine', 'https://www.shine.com/', 3600, true),
  ('freshersworld', 'Freshersworld', 'https://www.freshersworld.com/', 14400, true),
  ('cutshort', 'Cutshort', 'https://cutshort.io/', 14400, true),
  ('apna', 'apna', 'https://apna.co/', 14400, true),
  -- JavaScript-built pages; requires Chromium in catalog-firecrawl.
  ('hirist', 'Hirist', 'https://www.hirist.tech/', 14400, true),
  ('iimjobs', 'iimjobs', 'https://www.iimjobs.com/', 14400, true),
  ('unstop', 'Unstop', 'https://unstop.com/jobs', 14400, true),
  ('placementindia', 'PlacementIndia', 'https://www.placementindia.com/', 7200, true),
  ('internshala', 'Internshala', 'https://internshala.com/jobs/', 7200, true),
  ('talent', 'Talent.com', 'https://in.talent.com/', 7200, true),
  ('remoterocketship', 'Remote Rocketship', 'https://www.remoterocketship.com/country/india', 7200, true),
  -- Off: HerKey job pages redirect to a ?t= URL that takes ~36s to serve;
  -- NoDesk and Findwork kept 0 India jobs from 300 detail pages.
  ('herkey', 'HerKey', 'https://www.herkey.com/jobs', 7200, false),
  ('nodesk', 'NoDesk', 'https://nodesk.co/remote-jobs/', 14400, false),
  ('findwork', 'Findwork', 'https://findwork.dev/', 14400, false),
  ('jobspresso', 'Jobspresso', 'https://jobspresso.co/', 14400, true),
  ('remoterocketship-global', 'Remote Rocketship Global', 'https://www.remoterocketship.com/', 14400, true),
  ('bebee', 'beBee', 'https://bebee.com/in/jobs', 7200, true),
  ('indgovtjobs', 'IndGovtJobs', 'https://www.indgovtjobs.in/', 14400, true),
  ('hn-hiring', 'Hacker News Who is hiring', 'https://news.ycombinator.com/submitted?id=whoishiring', 21600, true)
) as sources(board, company, url, seconds, enabled)
on conflict (id) do nothing;
