# Gateway recall gain (research)

Status: hypothesis; the floor and enhancer paths now exist, so the comparison
can be designed but has not been run.

## Baseline after B8

- Floor: journals, task summaries, and spec sections. Always available,
  curated, bounded scan.
- Enhancers: seven harness stores behind schema checks, isolated per
  adapter, `partial` when one fails.

## What a gateway would add

| Dimension | Seven readers | Gateway |
|---|---|---|
| Format stability | internal schema, drifts silently | wire protocol, slower-moving |
| Coverage | only harnesses with a known store | any harness pointed at the gateway |
| Tool results | available in some stores | not visible; only the next request |
| Identity | session file / env | routing + injected markers |
| Cache risk | none | none if read-only |

## Comparison method

1. Pick three projects and one week of activity.
2. For each query, collect floor hits, enhancer hits, and (from a read-only
   capture) gateway hits.
3. Measure: recall@10, duplicate rate across sources, ordering by timestamps,
   and the share of turns that are `unattributed`.
4. Count the queries where floor + enhancers miss but the gateway finds a
   turn. This is the only number that justifies the gateway.

## Decision bar

The gateway is worth prototyping only if it finds ≥ 20% more relevant turns
than floor + enhancers with no increase in duplicate noise, across two or more
harnesses, and the identity experiments hold exact attribution ≥ 90%.
