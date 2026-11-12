#!/bin/bash
# Test suite without AI cost: runs the engine on every file that has a plan and scores the FIRST attempt.
#   scripts/suite.sh <inputdir> <specs.json> <workdir> [name ...]
# specs.json = { "<file stem>": [ <try-plan edits> ] }. Nothing is tuned between files; the score counts files
# where the engine itself reported no remaining problem ("Att titta på" / "Kontrollen är inte nöjd").
cd "$(dirname "$0")/.." || exit 1
IN="$1"; SPECS="$2"; W="$3"; shift 3
mkdir -p "$W/res" "$W/ocr"; rm -f "$W/res/PROGRESS"
names=("$@"); [ ${#names[@]} -eq 0 ] && names=($(python3 -c "import json,sys;print(' '.join(json.load(open('$SPECS')).keys()))"))
for n in "${names[@]}"; do
  f=$(ls "$IN/$n".* 2>/dev/null | head -1); [ -z "$f" ] && { echo "$n saknas" >> "$W/res/PROGRESS"; continue; }
  spec=$(python3 -c "import json;print(json.dumps(json.load(open('$SPECS'))['$n'],ensure_ascii=False))")
  ext="${f##*.}"
  OCRCACHE="$W/ocr" OCRTILES=1 timeout 900 npx tsx scripts/try-plan.ts "$f" "$W/out_$n.$ext" "$spec" > "$W/res/$n.log" 2>&1
done
clean=0; total=0; retried=0
for n in "${names[@]}"; do
  [ -f "$W/res/$n.log" ] || continue
  total=$((total+1))
  bad=$(grep -c "Att titta på\|inte nöjd\|Error\|TypeError" "$W/res/$n.log")
  r=$(grep -c "kontrollerades" "$W/res/$n.log")
  [ "$r" -gt 0 ] && retried=$((retried+1))
  if [ "$bad" -eq 0 ]; then clean=$((clean+1)); echo "OK     $n (omgjorda: $r)"; else echo "FEL    $n ($bad anmärkningar, omgjorda: $r)"; fi
done
echo "RESULTAT: $clean av $total utan egna anmärkningar; $retried hade minst en omgjord ändring"
echo ALL >> "$W/res/PROGRESS"
