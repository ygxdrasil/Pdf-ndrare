# Demomanual – PDF-ändraren

Kort guide för att visa produkten tryggt för en kund. Bygger på vad som fungerat bäst i testerna (ca 150 olika filer). Alla tester gjordes utan riktig Gemini-planering, så **gör en repetition med dina egna filer före mötet**.

## Före mötet (20 minuter)

1. Starta appen och kontrollera att `.env` med nyckeln finns och att en enkel ändring går igenom.
2. Kör de 5–8 demofilerna nedan med exakt de instruktioner du tänker använda. Spara resultaten, så har du en reservbild om något strular.
3. Ha en egen kundfil i reserv. Kör den i förväg, och visa den bara om den blev bra.
4. Öppna resultatet i zoom och jämför med originalet. Titta efter justering, fetstil och färg.

## Det som fungerar säkrast (visa dessa)

| Filtyp | Instruktion (exempel) | Varför det är tryggt |
|---|---|---|
| Faktura | "Ändra fakturanumret till 2026-0199" | Kort text, rak rad |
| Faktura | "Ändra alla kr till SEK" | Många liknande ställen, visar kraften |
| Faktura | "Byt kundnamn till …" | Ny text i samma stil |
| Prislista/meny | "Höj priset på X till 169 kr" | Högerjusterade belopp bevaras |
| Ritning | "Byt rumsnamnen från svenska till engelska" | Behåller placering och storlek |
| Affisch/reklamblad | "Byt rubriken till VINTERFEST" | Stor text, färg och typsnitt bevaras |
| Diplom/brev | "Byt namnet till …" | Centrerad eller fet text hanteras |
| Bild (PNG/JPG) | Samma som ovan | Fungerar lika bra som PDF |

## Skriv instruktioner så här

- Konkret: "Ändra priset på Hammare till 169,00 kr", inte "uppdatera priserna".
- Säg vad som ska ändras och till vad. Säg "överallt" bara när du vill det.
- En sak i taget i första demon, sedan flera ändringar tillsammans.

## Visa gärna själva självkontrollen

Motorn kontrollerar sitt eget resultat (krockar, stil, läser tillbaka med OCR) och varnar när den är osäker. Säg att det är därför "Att titta på"-noteringarna finns. Det är en styrka, inte ett fel.

## Undvik i första demon

- Text som sitter på en tjock linje eller bakom en vattenstämpel.
- Mycket liten text (under ca 5 pt).
- Text bredvid annan text på samma rad som blir mycket längre (den krymps).
- Ord som byter stil mitt i ordet (tvåfärgade logotyper).
- Ändringar som gör att ett stycke får en rad extra och trycker mot nästa stycke.
- Skannade sidor och lösenordsskyddade PDF:er.

## Om något går fel under mötet

- Säg att det är en tidig version och att motorn just därför varnar och inte gissar tyst.
- Kör om med en tydligare instruktion, eller byt till en reservfil.
- Visa gärna hur motorn bevarar det som inte ska ändras (layout, färger, övrig text) i stället för att fastna i detaljen.

## Vad du kan säga ärligt om läget

- Testat på ca 150 filer (fakturor, ritningar, reklamblad, menyer, brev, kvitton, affischer, bilder).
- De flesta ändringar blir rätt första gången, och motorn varnar vid osäkerhet.
- Kända begränsningar: se listan ovan. Planen för att minska dem finns i planen "PDF-ändraren – status och plan".
- Riktig AI-mätning med Gemini Pro återstår och planeras.
