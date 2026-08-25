#!/usr/bin/env python3
"""
Riscrive nel README la tabella delle zone leggendola da data/aree.json.

Serve a non far invecchiare i numeri: una tabella scritta a mano dopo tre
rigenerazioni non corrisponde piu' a nulla, e in un progetto che dichiara di
essere onesto sulla propria copertura sarebbe il difetto peggiore.
"""
import json

INIZIO = "<!-- zone:inizio -->"
FINE = "<!-- zone:fine -->"


def main():
    aree = json.load(open("data/aree.json"))["areas"]
    righe = ["| Zona | Regione | Passaggi a livello | Treni | Peso |",
             "|---|---|---|---|---|"]
    for a in aree:
        cop = (f"**{a['covered']} su {a['crossings']}** con previsione"
               if a["covered"] != a["crossings"]
               else f"tutti e {a['crossings']}")
        righe.append(f"| {a['name']} | {a['region']} | {cop} "
                     f"| {a['trains']} | {a['size_kb']} KB |")

    tot_pl = sum(a["crossings"] for a in aree)
    tot_cop = sum(a["covered"] for a in aree)
    righe.append("")
    righe.append(f"In totale **{tot_cop} passaggi a livello con previsione** "
                 f"su {tot_pl} censiti, in {len(aree)} zone.")

    testo = open("README.md").read()
    a = testo.index(INIZIO) + len(INIZIO)
    b = testo.index(FINE)
    open("README.md", "w").write(testo[:a] + "\n" + "\n".join(righe) + "\n" + testo[b:])
    print(f"README: {len(aree)} zone, {tot_cop}/{tot_pl} PL con previsione")


if __name__ == "__main__":
    main()
