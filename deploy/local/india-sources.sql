-- Verified public employer boards for the local India catalog.
-- Record source geography from published snapshots so collection measures supply.
insert into public.job_source_directory(id, kind, board, company, discovered_url, enabled)
select kind || ':' || board, kind, board, company,
  case kind
    when 'ashby' then 'https://jobs.ashbyhq.com/'
    when 'greenhouse' then 'https://job-boards.greenhouse.io/'
    when 'lever' then 'https://jobs.lever.co/'
    when 'workable' then 'https://apply.workable.com/'
  end || board,
  true
from (values
    ('ashby', 'tekion', 'Tekion'),
    ('ashby', 'loopio', 'Loopio'),
    ('ashby', 'bolna', 'Bolna AI'),
    ('greenhouse', 'appian', 'Appian'),
    ('greenhouse', 'capco', 'Capco'),
    ('greenhouse', 'coinbase', 'Coinbase'),
    ('greenhouse', 'connectwise', 'ConnectWise'),
    ('greenhouse', 'crunchyroll', 'Crunchyroll'),
    ('greenhouse', 'databricks', 'Databricks'),
    ('greenhouse', 'devrev', 'DevRev'),
    ('greenhouse', 'druva', 'Druva'),
    ('greenhouse', 'elastic', 'Elastic'),
    ('greenhouse', 'gleanwork', 'Glean'),
    ('greenhouse', 'gravitonresearchcapital', 'Graviton Research Capital'),
    ('greenhouse', 'hackerrank', 'HackerRank'),
    ('greenhouse', 'kermagames', 'Kerma Games'),
    ('greenhouse', 'ownwell', 'Ownwell'),
    ('greenhouse', 'pistontechnologies', 'Piston Technologies'),
    ('greenhouse', 'platformscience', 'Platform Science'),
    ('greenhouse', 'purestorage', 'Everpure'),
    ('greenhouse', 'rubrik', 'Rubrik'),
    ('greenhouse', 'saucelabs', 'Sauce Labs'),
    ('greenhouse', 'sonicwall', 'SonicWall'),
    ('greenhouse', 'stockx', 'StockX'),
    ('greenhouse', 'sumologic', 'Sumo Logic'),
    ('greenhouse', 'techholding', 'Tech Holding'),
    ('greenhouse', 'trivelta', 'Trivelta'),
    ('greenhouse', 'turing', 'Turing'),
    ('greenhouse', 'twilio', 'Twilio'),
    ('greenhouse', 'zscaler', 'Zscaler'),
    ('lever', 'brillio-2', 'Brillio'),
    ('lever', 'cin7', 'Cin7'),
    ('lever', 'entrata', 'Entrata'),
    ('lever', 'gohighlevel', 'HighLevel'),
    ('lever', 'jumpcloud', 'JumpCloud'),
    ('lever', 'mindtickle', 'Mindtickle'),
    ('lever', 'perforce', 'Perforce'),
    ('lever', 'propelsoftware', 'Propel Software Solutions'),
    ('lever', 'reply', 'Reply'),
    ('lever', 'shyftlabs', 'ShyftLabs'),
    ('lever', 'smart-working-solutions', 'Smart Working Solutions'),
    ('lever', 'thinkahead', 'AHEAD'),
    ('workable', 'horizontal-digital', 'Horizontal Digital')
) as sources(kind, board, company)
on conflict (id) do update set
  company = excluded.company,
  discovered_url = coalesce(job_source_directory.discovered_url, excluded.discovered_url),
  enabled = true;

-- These are new sources with fixed India scopes. Keep any existing global
-- source on its current configuration rather than sharing a snapshot cursor.
insert into public.job_source_directory(id, kind, board, company, discovered_url, enabled, countries, config)
select 'smartrecruiters:' || board, 'smartrecruiters', board, company,
  'https://careers.smartrecruiters.com/' || career_slug, true, array['India'], '{"country":"IN"}'::jsonb
from (values
  ('aristanetworks', 'AristaNetworks', 'Arista Networks'),
  ('aurionprosolutions3', 'AurionProSolutions3', 'Aurionpro Solution Ltd.'),
  ('boschgroup', 'BoschGroup', 'Bosch Group'),
  ('bradycorporation3', 'BradyCorporation3', 'Brady Corporation'),
  ('endava', 'Endava', 'Endava'),
  ('eurofins', 'Eurofins', 'Eurofins'),
  ('experian', 'Experian', 'Experian'),
  ('freshworks', 'Freshworks', 'Freshworks'),
  ('hmgroup', 'HMGroup', 'H&M Group'),
  ('liftedanupworkcompany', 'LiftedanUpworkCompany', 'Lifted, an Upwork Company'),
  ('linkedin3', 'LinkedIn3', 'LinkedIn'),
  ('nagarro', 'Nagarro', 'Nagarro'),
  ('necsws', 'NECSWS', 'NEC Software Solutions'),
  ('nielseniq', 'NielsenIQ', 'NielsenIQ'),
  ('qadinc', 'QADInc', 'QAD'),
  ('servicenow', 'ServiceNow', 'ServiceNow'),
  ('soprasteria1', 'SopraSteria1', 'Sopra Steria'),
  ('thenielsencompany', 'TheNielsenCompany', 'Nielsen'),
  ('version1', 'Version1', 'Version 1'),
  ('wabtec', 'Wabtec', 'Wabtec'),
  ('westerndigital', 'WesternDigital', 'Western Digital'),
  ('xplor', 'Xplor', 'Xplor Technologies')
) as sources(board, career_slug, company)
on conflict (id) do nothing;

-- Government-operated park vacancies and the employer-designated Oracle boards.
insert into public.job_source_directory(id, kind, board, company, discovered_url, enabled, countries)
values
  ('infopark:kerala', 'infopark', 'kerala', 'Infoparks Kerala', 'https://infopark.in/companies-job', true, array['India']),
  ('oracle:bny', 'oracle', 'bny', 'BNY', 'https://eofe.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/BNY-Careers/jobs', true, array['India']),
  ('oracle:ibs-software', 'oracle', 'ibs-software', 'IBS Software', 'https://fa-etbm-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/', true, array['India'])
on conflict (id) do nothing;

insert into public.job_source_directory(id, kind, board, company, discovered_url, enabled, countries)
values ('amazon:india-software', 'amazon', 'india-software', 'Amazon',
  'https://www.amazon.jobs/en/search?normalized_country_code%5B%5D=IND&category%5B%5D=software-development&sort=recent',
  true, array['India'])
on conflict (id) do nothing;
