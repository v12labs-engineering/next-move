#!/usr/bin/env python3
"""Stream public corporate registry snapshots into the local employer database."""

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import subprocess
import unicodedata
import zipfile
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DB = 'india_employer_registry'
SCHEMA = ROOT / 'deploy/local/india-registry.sql'
MAP_SCHEMA = ROOT / 'deploy/local/india-registry-map.sql'
LEGAL_SUFFIX = r'(?:(?:private|public)?limited|llp)$'
PUBLISH = '''
insert into public.registry_snapshot (
  sha256, as_of, source_url, attribution, input_rows, accepted_rows, distinct_registrations
)
select :'digest', :'as_of', :'source_url', :'attribution', :input_rows,
       count(*), count(distinct registration_id)
from registry_import
on conflict (sha256) do nothing;

insert into public.registry_company (
  registration_id, legal_name, name_key, company_status, region, city,
  legal_form, activity_hint, snapshot_sha256, snapshot_date
)
select distinct on (registration_id) registration_id, legal_name, name_key,
  company_status, region, city, legal_form, activity_hint, :'digest', :'as_of'
from registry_import
where lower(company_status) = 'active'
order by registration_id, legal_name, company_status, region, city, legal_form, activity_hint
on conflict (registration_id) do update set
  legal_name = excluded.legal_name, name_key = excluded.name_key,
  company_status = excluded.company_status, region = excluded.region, city = excluded.city,
  legal_form = excluded.legal_form, activity_hint = excluded.activity_hint,
  snapshot_sha256 = excluded.snapshot_sha256, snapshot_date = excluded.snapshot_date
where (registry_company.snapshot_date, registry_company.snapshot_sha256)
    < (excluded.snapshot_date, excluded.snapshot_sha256);
delete from public.registry_company c using registry_import incoming
where incoming.registration_id = c.registration_id
  and lower(incoming.company_status) is distinct from 'active'
  and (c.snapshot_date,c.snapshot_sha256) < (:'as_of'::date,:'digest')
  and not exists (
    select 1 from registry_import active
    where active.registration_id=c.registration_id and lower(active.company_status)='active'
  );
commit;
analyze public.registry_company;
select input_rows, accepted_rows, distinct_registrations from public.registry_snapshot where sha256 = :'digest';
'''

MATCH_LINKS = '''
with names as (
  select name_key, min(employer_key) as employer_key
  from link_import group by name_key having count(distinct employer_key) = 1
), unique_companies as (
  select c.name_key, min(c.registration_id) as registration_id
  from public.registry_company c join names on names.name_key = c.name_key
  group by c.name_key having count(*) = 1
)
insert into public.registry_company_link as saved
  (registration_id, employer_key, kind, url, evidence_url, evidence_source)
select distinct on (c.registration_id, l.kind, l.url)
  c.registration_id, l.employer_key, l.kind, l.url, l.evidence_url, l.evidence_source
from link_import l join unique_companies c on c.name_key = l.name_key
join names on names.name_key = l.name_key and names.employer_key = l.employer_key
where l.url is not null
order by c.registration_id, l.kind, l.url, l.evidence_url, l.evidence_source
on conflict (registration_id, kind, url) do update set
  evidence_url = excluded.evidence_url, evidence_source = excluded.evidence_source
where (saved.evidence_url, saved.evidence_source) is distinct from
      (excluded.evidence_url, excluded.evidence_source);
commit;
'''

MATCH_PLACES = '''
with leads as (
  select name_key,region,min(url) as url,min(place_id) as place_id
  from places_import group by name_key,region having count(distinct url) = 1
), unique_companies as (
  select l.name_key,l.region,min(c.registration_id) as registration_id,min(c.name_key) as employer_key
  from leads l join public.registry_company c
    on l.name_key = case when :'match_brand'::boolean
      then regexp_replace(c.name_key, :'legal_suffix', '') else c.name_key end
  where lower(c.company_status) = 'active' and lower(c.region) = l.region
  group by l.name_key,l.region having count(*) = 1
)
insert into public.registry_company_link
  (registration_id,kind,url,evidence_url,evidence_source,employer_key)
select c.registration_id,'website',l.url,'https://docs.overturemaps.org/blog/2026/10/21/release-notes/',
       'Overture Maps Places 2026-10-21.0 ' || :'area' || '. GERS ID ' || l.place_id
         || case when :'match_brand'::boolean then '. Brand and state match' else '' end,
       c.employer_key
from leads l join unique_companies c using (name_key,region)
where not :'match_brand'::boolean or not exists (
  select 1 from public.registry_company_link site
  where site.registration_id=c.registration_id and site.kind='website' and site.status='public'
)
on conflict (registration_id,kind,url) do nothing;
commit;
'''


def psql_args(project, database):
    return [
        'docker', 'compose', '-p', project,
        '--env-file', '.local-data/compose/local.env', '-f', 'deploy/local/compose.yml',
        'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', database,
        '-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off',
    ]


def psql(project, database, sql):
    subprocess.run(psql_args(project, database), cwd=ROOT, input=sql, text=True, check=True)


def init(project):
    psql(project, 'postgres', '''
select pg_advisory_lock(927451307);
select 'create database india_employer_registry' where not exists
  (select from pg_database where datname = 'india_employer_registry')
\\gexec
''')
    psql(project, DB, SCHEMA.read_text() + '\n' + MAP_SCHEMA.read_text())


@contextmanager
def stream_sql(project, variables=()):
    args = psql_args(project, DB)
    for key, value in variables:
        args.extend(['-v', f'{key}={value}'])
    with subprocess.Popen(args, cwd=ROOT, stdin=subprocess.PIPE, text=True, encoding='utf-8') as proc:
        try:
            yield proc.stdin
        except BaseException:
            proc.terminate()
            raise
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError('Local registry transaction failed')


def clean(value):
    return ' '.join((value or '').replace('\0', '').split())


def name_key(name):
    value = unicodedata.normalize('NFKC', name).casefold()
    value = re.sub(r'\(p\)(?=\s*l(?:imited|td)\b)', ' private ', value)
    parts = re.findall(r'[^\W_]+', value, re.UNICODE)
    aliases = {'pvt': 'private', 'ltd': 'limited'}
    return ''.join(aliases.get(part, part) for part in parts)


def header_key(value):
    return re.sub(r'[^a-z0-9]', '', value.casefold())


@contextmanager
def csv_files(path):
    if path.suffix == '.zip':
        with zipfile.ZipFile(path) as zipped:
            entries = [entry for entry in zipped.infolist() if entry.filename.lower().endswith('.csv') and not entry.is_dir()]
            if not entries:
                raise ValueError('Archive contains no CSV files')
            def files():
                for entry in entries:
                    with zipped.open(entry) as member, io.TextIOWrapper(member, encoding='utf-8-sig', newline='') as text:
                        yield text
            yield files()
    else:
        opener = gzip.open if path.suffix == '.gz' else open
        with opener(path, 'rt', encoding='utf-8-sig', newline='') as text:
            yield [text]


def corporate_rows(file):
    reader = csv.reader(file)
    columns = {header_key(name): index for index, name in enumerate(next(reader))}

    def index(*aliases):
        return next((columns[alias] for alias in aliases if alias in columns), None)

    fields = (
        index('regnumberraw', 'cin', 'corporateidentificationnumber', 'llpin', 'fcrn'),
        index('legalnamenorm', 'companyname', 'llpname'),
        index('status', 'companystatus', 'llpstatus'),
        index('addrregion', 'registeredstate', 'companystatecode', 'state'),
        index('addrcity', 'city'), index('legalform', 'companyclass', 'companycategory'),
        index('niccode', 'principalbusinessactivity', 'companyindustrialclassification'),
    )
    if fields[0] is None or fields[1] is None:
        raise ValueError('Unrecognized registry header: expected registration number and company name')
    for row in reader:
        if not row or (len(row) == 1 and not row[0].strip()):
            continue
        if len(row) != len(columns):
            raise ValueError(f'Unexpected number of registry fields at CSV line {reader.line_num}')
        reg, name, status, region, city, legal_form, activity = [clean(row[i]) if i is not None else '' for i in fields]
        reg = reg.upper().replace(' ', '')
        key = name_key(name)
        if not re.fullmatch(r'[A-Z0-9-]{3,40}', reg) or not key or len(name) > 500:
            yield None
            continue
        # CIN's industry segment is a useful lookup hint when the file omits activities.
        cin_activity = re.fullmatch(r'[LU]([0-9]{5})[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}', reg)
        hint = activity if activity.casefold() not in ('', 'na', 'n/a') else cin_activity[1] if cin_activity else ''
        yield [reg, name, key, status, region, city, legal_form, hint]


def import_snapshot(project, args):
    with args.file.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    if args.sha256 and digest != args.sha256.lower():
        raise ValueError(f'Snapshot checksum differs: {digest}')
    existing = subprocess.run(
        [*psql_args(project, DB), '-At', '-v', f'digest={digest}'], cwd=ROOT,
        input="select 1 from public.registry_snapshot where sha256 = :'digest';\n",
        text=True, check=True, capture_output=True,
    )
    if existing.stdout.strip() == '1':
        print(f'Snapshot already imported ({digest})')
        return
    data = [('digest', digest), ('as_of', args.as_of.isoformat()), ('source_url', args.source_url), ('attribution', args.attribution)]
    with stream_sql(project, data) as pipe:
        pipe.write('''begin;
select pg_advisory_xact_lock(927451309);
create temp table registry_import (
  registration_id text, legal_name text, name_key text, company_status text,
  region text, city text, legal_form text, activity_hint text
) on commit drop;
copy registry_import from stdin with (format csv);
''')
        writer = csv.writer(pipe, lineterminator='\n')
        total = accepted = 0
        with csv_files(args.file) as files:
            for file in files:
                for row in corporate_rows(file):
                    total += 1
                    if row:
                        writer.writerow(row)
                        accepted += 1
        if not accepted:
            raise ValueError('No valid company registration rows')
        pipe.write('\\.\n')
        pipe.write(f'\\set input_rows {total}\n')
        pipe.write(PUBLISH)


def https(value):
    if not isinstance(value, str) or len(value) > 8000 or any(char.isspace() for char in value):
        return None
    try:
        target = urlsplit(value)
        if target.scheme == 'https' and target.hostname and not target.username and not target.password and not target.port:
            return value
    except ValueError:
        return None
    return None


def directory_links(file):
    for employer in json.loads(file.read_text())['employers']:
        key = employer['id']
        evidence = []
        labels = {name_key(employer['name'])}
        for observation in employer['observations']:
            labels.add(name_key(observation['name']))
            for kind, field in [('website', 'website'), ('careers', 'careerUrl')]:
                evidence.append([kind, https(observation.get(field)), https(observation['evidenceUrl']), clean(observation['source'])])
        for page in (employer.get('links') or {}).get('careerPages', []):
            evidence.append(['careers', https(page['url']), https(page['evidenceUrl']), 'Saved employer career-link check'])
        for label in sorted(labels):
            yield [label, key, '', '', '', '']
            for kind, url, source_url, source in evidence:
                if label and url and source_url and source:
                    if kind == 'careers' and urlsplit(url).hostname.removeprefix('www.') in ('infopark.in', 'infoparkjobs.in'):
                        kind = 'park_listing'
                    yield [label, key, kind, url, source_url, source]


def enrich(project, file):
    with stream_sql(project) as pipe:
        pipe.write('''begin;
create temp table link_import (name_key text, employer_key text, kind text, url text, evidence_url text, evidence_source text) on commit drop;
copy link_import from stdin with (format csv);
''')
        csv.writer(pipe, lineterminator='\n').writerows(directory_links(file))
        pipe.write('\\.\n' + MATCH_LINKS)


METRO_REGIONS = {'Bengaluru': 'karnataka', 'Hyderabad': 'telangana'}
PLACES_REGIONS = {
    'an': 'andaman and nicobar islands', 'ap': 'andhra pradesh',
    'ar': 'arunachal pradesh', 'as': 'assam', 'br': 'bihar',
    'ch': 'chandigarh', 'cg': 'chhattisgarh', 'ct': 'chhattisgarh',
    'dh': 'dadra & nagar haveli', 'dn': 'dadra & nagar haveli',
    'dd': 'daman and diu', 'dl': 'delhi', 'ga': 'goa', 'gj': 'gujarat',
    'hr': 'haryana', 'hp': 'himachal pradesh', 'jk': 'jammu & kashmir',
    'jh': 'jharkhand', 'ka': 'karnataka', 'kl': 'kerala', 'la': 'ladakh',
    'ld': 'lakshadweep', 'mp': 'madhya pradesh', 'mh': 'maharashtra',
    'mn': 'manipur', 'ml': 'meghalaya', 'mz': 'mizoram', 'nl': 'nagaland',
    'od': 'orissa', 'or': 'orissa', 'py': 'pondicherry', 'pb': 'punjab',
    'rj': 'rajasthan', 'sk': 'sikkim', 'tn': 'tamil nadu',
    'ts': 'telangana', 'tg': 'telangana', 'tr': 'tripura',
    'up': 'uttar pradesh', 'ut': 'uttarakhand', 'uk': 'uttarakhand',
    'wb': 'west bengal', 'odisha': 'orissa', 'puducherry': 'pondicherry',
    'jammu and kashmir': 'jammu & kashmir', 'new delhi': 'delhi',
}


def enrich_places(project, file, metro, match_brand):
    area = metro or 'India'
    variables = [('area', area), ('match_brand', str(match_brand).lower()), ('legal_suffix', LEGAL_SUFFIX)]
    with file.open(encoding='utf-8-sig', newline='') as source, stream_sql(project, variables) as pipe:
        pipe.write('''begin;
create temp table places_import (name_key text,url text,place_id text,region text) on commit drop;
copy places_import from stdin with (format csv);
''')
        out = csv.writer(pipe, lineterminator='\n')
        for row in csv.DictReader(source):
            key = name_key(row['name'])
            if match_brand:
                key = re.sub(LEGAL_SUFFIX, '', key)
            website = https(row['website'])
            code = clean(row['region']).casefold().removeprefix('in-')
            region = PLACES_REGIONS.get(code, code)
            if key and website and row['place_id'] and region and (not metro or METRO_REGIONS[metro] == region):
                out.writerow([key, website, row['place_id'], region])
        pipe.write('\\.\n' + MATCH_PLACES)


def status(project):
    psql(project, DB, '''
select count(*) registrations, pg_size_pretty(pg_database_size(current_database())) registry_size from public.registry_company;
select kind, status, count(*) links, count(distinct registration_id) companies
from public.registry_company_link group by kind, status order by kind, status;
select as_of, source_url, input_rows, accepted_rows, distinct_registrations from public.registry_snapshot order by as_of desc;
''')


def prune_inactive(project):
    psql(project, DB, '''
begin;
select pg_advisory_xact_lock(927451309);
delete from public.registry_company where lower(company_status) is distinct from 'active';
commit;
analyze public.registry_company;
''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, help='Local Docker Compose project name')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('init')
    commands.add_parser('status')
    commands.add_parser('prune-inactive')
    load = commands.add_parser('import')
    load.add_argument('file', type=Path)
    load.add_argument('--as-of', required=True, type=date.fromisoformat)
    load.add_argument('--source-url', required=True)
    load.add_argument('--attribution', required=True)
    load.add_argument('--sha256')
    join = commands.add_parser('enrich')
    join.add_argument('file', nargs='?', type=Path, default=ROOT / '.local-data/india-employer-directory.json')
    places = commands.add_parser('enrich-places')
    places.add_argument('file', type=Path)
    places.add_argument('--metro', choices=METRO_REGIONS)
    places.add_argument('--match-brand', action='store_true')
    args = parser.parse_args()
    if args.command == 'init':
        init(args.project)
    elif args.command == 'status':
        status(args.project)
    elif args.command == 'prune-inactive':
        prune_inactive(args.project)
    elif args.command == 'import':
        if not https(args.source_url) or not clean(args.attribution):
            parser.error('Use a public HTTPS source URL and non-empty attribution')
        import_snapshot(args.project, args)
    elif args.command == 'enrich':
        enrich(args.project, args.file)
    else:
        enrich_places(args.project, args.file, args.metro, args.match_brand)


if __name__ == '__main__':
    main()
