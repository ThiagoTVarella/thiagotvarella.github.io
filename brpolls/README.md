# Brazil 2026 runoff poll aggregator (Lula vs Flávio Bolsonaro)

Static page: `index.html` (reads the JSON in `data/`). Everything is rebuilt by scripts; nothing is hand-edited
except `data/raw/overrides.json` (documented manual decisions).

## Rebuild
```
python scripts/ratings.py                                   # needs data/hist/*.csv
python scripts/average.py --ratings data/pollster_ratings.json
python scripts/forecast.py
```
Add new runoff polls to `data/raw/verified_*.json` (schema in `scripts/build_database.py` / the existing files), then
```
curl -O https://cdn.tse.jus.br/estatistica/sead/odsele/pesquisa_eleitoral/pesquisa_eleitoral_2026.zip && unzip pesquisa_eleitoral_2026.zip
python scripts/build_database.py --registry pesquisa_eleitoral_2026_BRASIL.csv
```

## Data
| File | What |
|---|---|
| `data/polls_runoff_lula_flavio.{csv,json}` | 92 national runoff polls from 14 Aug 2026, each checked against the pollster's release or a major outlet and joined to its TSE registration |
| `data/tse_national_registrations.csv` | national presidential polls registered with the TSE (census to check against); several registered runoff polls were still unpublished on 20 Oct |
| `data/hist/results_*.csv` | official TSE results, president and governor, 2002-2026 |
| `data/hist/polls_*.csv` | historical polls from Wikipedia (not independently verified), long format |
| `data/pollster_ratings.json`, `race_errors.csv`, `cycle2026_first_round.json` | ratings and the scored errors behind them |
| `data/average.json`, `data/forecast.json` | outputs used by the page |

## Known limits
- Historical polls: no usable 2002/2006 polls, thin 2014 (no governor polls for 10 states), pollster names normalised only for the main institutes, some Wikipedia tables inconsistent (flagged in the notes column; shares outside 90-105 kept as published).
- Ratings: simplified plus-minus on valid-vote margin, shrunk toward average; pollsters with short history marked unrated.
- Forecast: shared polling error (2 points of share) is a judgement call; only two past runoffs had enough final-week polls.
- The average is centred on the pollsters' consensus. The 2026 first round showed the consensus leaned to Lula, so a second, adjusted estimate corrects each pollster by half its own first-round miss (the 0.5 persistence is a judgement call).
- Unconfirmed polls: DataTrends 12-14 Sep (blog/search snippets only); registered polls from Alfa, IFP, Phoenix, Ranking and JOTA not yet found published.
