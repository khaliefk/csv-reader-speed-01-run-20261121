[![Read broken CSV files faster](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/khaliefk/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/khaliefk/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# csv-reader-speed-01-run-20261121

A faster drop-in for csv-reader 1.0.0. `solve.js` answers every input exactly
as csv-reader does, `{columns, rows, errors}`, including its broken-row policy
(BOM, CRLF/LF, stray CRs, quoted fields, doubled quotes, junk after a closing
quote, quotes that never close, short and long rows), but it cuts fields out
with native `indexOf` and `slice` instead of reading the text one character at
a time. `main.ts` is the harness driver: it reads `/input/cases.json`, answers
each case with `run()`, and writes `/output/answers.json`. Dependency-free,
no network, no WASM, no native code.

On the practice set (6 cases, about 10.2 MB of CSV) it answers all 6 cases
identically to the reference and runs clearly faster than the house baseline;
see the verification numbers in the entry report.
