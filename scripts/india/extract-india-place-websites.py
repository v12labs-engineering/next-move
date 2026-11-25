#!/usr/bin/env python3
"""Extract public company website leads from the October 2026 Overture release."""

import argparse
import csv
from pathlib import Path
from urllib.parse import urlsplit

import duckdb

RELEASE = '2026-10-21.0'
INDEX = f'https://stac.overturemaps.org/{RELEASE}/collections.parquet'
INDIA_BOUNDS = (68, 5.5, 98, 38)
NON_COMPANY_SITES = frozenset('''
    facebook.com linkedin.com instagram.com youtube.com google.com goo.gl g.page
    yelp.com justdial.com indiamart.com twitter.com x.com whatsapp.com linktr.ee
    business.site ycombinator.com wa.me forms.gle
'''.split())


def candidate_origin(value):
    try:
        url = urlsplit(value)
        domain = (url.hostname or '').removeprefix('www.').rstrip('.')
        if (
            url.scheme not in ('http', 'https') or url.username or url.password
            or url.port or '.' not in domain
            or any(domain == site or domain.endswith('.' + site) for site in NON_COMPANY_SITES)
        ):
            return None
        return 'https://' + domain
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--include-brand-names', action='store_true')
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix('.partial')
    with duckdb.connect() as db:
        db.execute("SET extension_directory = ?", [str(output.parent / '.duckdb-extensions')])
        db.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET threads=6")
        partitions = db.execute("""
            select distinct assets.aws.alternate.s3.href
            from read_parquet(?)
            where collection = 'place' and type = 'Feature'
              and bbox.xmax >= ? and bbox.ymax >= ? and bbox.xmin <= ? and bbox.ymin <= ?
        """, [INDEX, *INDIA_BOUNDS]).fetchall()
        if not partitions:
            raise RuntimeError('No Overture place partitions overlap India')
        print(f'Reading {len(partitions)} public Overture partitions overlapping India', flush=True)
        xmin, ymin, xmax, ymax = INDIA_BOUNDS
        rows = db.execute(r"""
            select id, names.primary, websites,
                   list_distinct(list_transform(
                     list_filter(addresses, lambda address: address.country = 'IN' and trim(address.region) <> ''),
                     lambda address: address.region
                   )) as regions
            from read_parquet(?) p
            where p.bbox.xmin between ? and ? and p.bbox.ymin between ? and ?
              and p.operating_status is distinct from 'permanently_closed'
              and len(p.websites) > 0
              and (? or regexp_matches(p.names.primary, '\b(?:limited|ltd|llp)\.?\s*$', 'i'))
              and len(regions) > 0
        """, [[path for (path,) in partitions], xmin, xmax, ymin, ymax, args.include_brand_names])
        total = 0
        with partial.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['name', 'website', 'place_id', 'region'])
            while batch := rows.fetchmany(5000):
                for place_id, name, websites, regions in batch:
                    origins = sorted({origin for url in websites if (origin := candidate_origin(url))})
                    for region in sorted(regions):
                        for origin in origins:
                            writer.writerow([name, origin, place_id, region])
                            total += 1
    partial.replace(output)
    print(f'Exported {total:,} public place-and-website observations to {output}')


if __name__ == '__main__':
    main()
