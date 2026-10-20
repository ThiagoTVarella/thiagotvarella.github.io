"""Build a checklist of national presidential polls from the TSE PesqEle registry.

Every published electoral poll in Brazil must be registered with the TSE at least
five days before release, so the registry is the census we check the database
against. Download the registry with:
    curl -O https://cdn.tse.jus.br/estatistica/sead/odsele/pesquisa_eleitoral/pesquisa_eleitoral_2026.zip
    unzip pesquisa_eleitoral_2026.zip
then run:
    python tse_registry.py pesquisa_eleitoral_2026_BRASIL.csv > ../data/tse_national_registrations.csv

The registry says nothing about which questions were asked, so a registration
here is a poll that *may* contain a Lula vs Flávio runoff question.
"""
import csv
import re
import sys
import unicodedata

START = "2026-08-14"

STATES = ("acre|alagoas|amapa|amazonas|bahia|ceara|distrito federal|espirito santo|"
          "goias|maranhao|mato grosso(?: do sul)?|minas gerais|para|paraiba|parana|"
          "pernambuco|piaui|rio de janeiro|rio grande do norte|rio grande do sul|"
          "rondonia|roraima|santa catarina|sao paulo|sergipe|tocantins")
STATE_RE = re.compile(rf"\b(?:estado|eleitorado|territorio|unidade da federacao)"
                      rf"\s+(?:d[aeo]s?\s+)?(?:{STATES})\b|\bdo estado\b")
NATIONAL_RE = re.compile(
    r"territorio (?:do brasil|nacional|brasileiro)|eleitorado brasileiro|"
    r"todo o (?:pais|brasil)|ambito nacional|abrangencia nacional|nivel nacional|"
    r"amostra nacional|todas as (?:regioes|unidades da federacao|ufs)|"
    r"(?:cinco|5) (?:grandes )?regioes|27 (?:unidades|ufs)|eleitores brasileiros")


def norm(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def scope(row):
    text = norm(" ".join(row[k] for k in ("DS_METODOLOGIA_PESQUISA",
                                          "DS_PLANO_AMOSTRAL", "DS_DADO_MUNICIPIO")))
    nat, st = bool(NATIONAL_RE.search(text)), bool(STATE_RE.search(text))
    if nat and not st:
        return "national"
    if st and not nat:
        return "state"
    return "unclear"


def main(path):
    out = csv.writer(sys.stdout)
    out.writerow(["tse_registration", "pollster", "company", "field_start",
                  "field_end", "release_date", "sample_size", "scope", "cost_brl"])
    with open(path, encoding="latin1") as f:
        rows = [r for r in csv.DictReader(f, delimiter=";")
                if r["DS_CARGO"] == "Presidente" and r["DT_INICIO_PESQUISA"] >= START]
    for r in sorted(rows, key=lambda r: r["DT_FIM_PESQUISA"], reverse=True):
        s = scope(r)
        if s == "state":
            continue
        reg = r["NR_PROTOCOLO_REGISTRO"]
        fantasy = r["NM_EMPRESA_FANTASIA"]
        out.writerow([f"{reg[:2]}-{reg[2:7]}/{reg[7:]}",
                      fantasy if fantasy and fantasy != "#NULO#" else r["NM_EMPRESA"],
                      r["NM_EMPRESA"], r["DT_INICIO_PESQUISA"][:10],
                      r["DT_FIM_PESQUISA"][:10], r["DT_DIVULGACAO"][:10],
                      r["QT_ENTREVISTADO"], s, r["VR_PESQUISA"]])


if __name__ == "__main__":
    main(sys.argv[1])
