# ifc.vr – prohlížeč IFC ve VR

Jednoduchá webová aplikace (WebXR) pro prohlížení modelu IFC v brýlích **Meta Quest 3**.
Běží v prohlížeči Quest Browser, do brýlí se nic neinstaluje. Na počítači funguje jako běžný 3D prohlížeč.

- načtení IFC přetažením, výběrem souboru, ze složky `models/` nebo přes `?model=a.ifc&model=b.ifc`
- **více modelů najednou** (např. profese stavby): sedí na sebe podle souřadnic prvního modelu; model se
  souřadnicemi dál než 10 km se umístí do počátku. Načtené modely jde jednotlivě skrýt, přebarvit jednou
  barvou (kolečko vedle názvu: 12 barev, vlastní barva nebo původní barvy z IFC; ve VR se klepnutím střídají),
  přiblížit (klepnutí na název) a odebrat –
  na počítači v panelu vlevo, ve VR na záložce **Modely** panelu u levé ruky (tam i *Přidat soubor*,
  které ukončí VR a otevře výběr souborů)
- **VR 1:1**: procházení modelem ve skutečné velikosti (teleport, chůze, let nahoru/dolů); začíná se před
  budovou na podlaze **1NP** (podlaží s názvem 1NP / 1.NP / přízemí, jinak s výškou nejblíž ±0,00), ve stejné
  výšce je mřížka a podlaha pro teleport mimo budovu
- **Maketa / AR**: zmenšený model před vámi, v AR na stole v reálném prostoru (průhled kamer Quest 3);
  úchopem se posouvá, oběma rukama otáčí a zvětšuje; po návratu z makety do 1:1 jste tam, kde jste ji zapnuli
- výběr prvku a jeho vlastnosti (typ, podlaží, GlobalId, sady vlastností a množství); ve VR na vlastní kartě
  vpravo vedle panelu u levé ruky (karty se drží za levý dolní roh). Výběr se zruší tlačítkem *Zrušit výběr*
  nebo spouští znovu na vybraný prvek
- **mapa**: půdorys podlaží (pohled shora, řez 1,2 m nad podlahou) s polohou a směrem pohledu uživatele;
  klepnutím do půdorysu se přesunete na místo – na počítači tlačítko *Mapa* (pohled z výšky očí), ve VR záložka
  **Mapa** na panelu u levé ruky. Přesun jde jen na podlahu podlaží nebo schod (ne do zdi, na nábytek ani mimo budovu)
- **Mojžíšův mód**: model kolem uživatele „ustoupí“ – ve válci o poloměru 3, 6 nebo 10 m se nad úrovní nohou
  nic nekreslí (zdi, stropy, nábytek), podlaha zůstane, okraj výřezu je oranžový; je vidět dovnitř budovy.
  Ve VR kolem vás (panel u levé ruky), na počítači kolem středu otáčení od podlahy jeho podlaží. Co je ve výřezu,
  nejde vybrat ani na to teleportovat
- **zastínění koutů**: spoje zdí s podlahou a stropem, kouty a prostor pod nábytkem jsou tmavší (prostor
  působí plastičtěji). Počítá se jednou při načtení (u velkého modelu asi sekundu) a ukládá se do mezipaměti
- **obrysové hrany** (volba *Obrysové hrany* na počítači, tlačítko **Hrany** ve VR; výchozí vypnuto): tmavé
  čáry na hranách prvků jako na výkrese, zdi a stropy stejné barvy se od sebe lépe odliší
- **zrušení načítání**: u průběhu je křížek, který zastaví právě načítaný model, a čekající soubory ve frontě
  jdou vyřadit každý zvlášť. Každý model má vlastní worker, odebrání modelu uvolní i jeho paměť
- **otevírání dveří**: křídlo se otočí o 90° kolem pantu, od pozorovatele. Na počítači dvojklik na dveře
  nebo tlačítko *Otevřít dveře* u vybraného prvku, ve VR spoušť znovu na už vybrané dveře. Křídlo se pozná
  podle tvaru (tenká deska přes většinu výšky, klika a sklo k ní patří, pant proti klice); posuvné, skládací
  a otočné dveře se neotevírají. Volba **Dveře: Automaticky** (na počítači i ve VR, pamatuje se) otevře dveře,
  když k nim přijdete na 2 m, a zavře je, když odejdete dál než 3 m; dveře otevřené nebo zavřené ručně nechá.
- **měření** (na počítači sekce *Měření*, ve VR záložka **Měření** – dokud je otevřená, spoušť měří místo výběru prvku):
  - *Laser* (jen VR): vzdálenost od ovladače k místu, kam míříte, je vidět průběžně u kurzoru; spoušť ji uloží,
  - *Dva body*: vzdálenost a její složky ΔX, ΔY, ΔZ,
  - *Bod*: souřadnice X, Y, Z v systému IFC (Z nahoru, skutečné souřadnice včetně posunu modelu, např. S-JTSK),
  - *Úhel*: ze tří bodů (bod na rameni, vrchol, bod na druhém rameni).

  Body se přichytí k rohu prvku, a není-li roh blízko, k hraně prvku (jen skutečné hrany, ne úhlopříčky ploch;
  volba *Přichytit*, zeleně = přichyceno, přichycená hrana se zvýrazní). Dosah je 3 % vzdálenosti, nejméně 1,5 cm. V maketě se
  měří skutečné rozměry. Výsledky jsou u čar v modelu (štítky drží stálou velikost) a v seznamu, kde jde každé
  měření smazat zvlášť (křížek na počítači, *Smazat* ve VR; ve VR se seznam listuje po stránkách); *Zpět* odebere
  poslední bod nebo měření, na počítači Esc zruší rozpracované body. Odebráním všech modelů se měření smažou.

Technika: [three.js](https://threejs.org), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) ve Web Workeru
(geometrie se slučuje podle barvy kvůli výkonu brýlí), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
pro rychlý výběr a teleport, [Vite](https://vite.dev). Vzhled podle EBC_UI_vibe 2.7.0 (`src/ebc/`, `public/ebc/` –
zkopírované soubory, needitovat).

## Spuštění

```bash
npm install
```

```bash
npm run dev
```

Na počítači otevřete <http://localhost:5173>.

## Do brýlí Quest 3

WebXR vyžaduje zabezpečené připojení (`https://` nebo `localhost`).

**Hlavní cesta: GitHub Pages + instalace jako aplikace.** Po každém pushi do `main` se aplikace sama nasadí
(`.github/workflows/pages.yml`; jednorázově v repozitáři *Settings → Pages → Source: GitHub Actions*).

1. V Questu otevřete v prohlížeči adresu aplikace na GitHub Pages.
2. V nabídce prohlížeče zvolte **Nainstalovat aplikaci**, ikona *IFC VR* se objeví v knihovně aplikací.
   Po prvním spuštění funguje i offline.
3. Soubory IFC si stáhněte do brýlí (např. z OneDrive / SharePointu v prohlížeči Questu) a otevřete je
   klepnutím na drop zónu. Ve výběru souborů jde označit víc souborů najednou (dlouhé podržení spouště na
   prvním souboru, pak klepnout na další). Další model jde přidat i později dalším klepnutím na drop zónu.
   Modely se zpracují jen v brýlích, nikam se neodesílají.

Pro vývoj jde aplikaci pustit i z počítače:

**A) Wi-Fi** – počítač a brýle ve stejné síti:

```bash
npm run dev:quest
```

V brýlích v prohlížeči otevřete adresu `https://<IP počítače>:5173` (vypíše ji Vite jako *Network*).
Prohlížeč upozorní na certifikát podepsaný sám sebou: **Pokročilé → Pokračovat**. Případně povolte port 5173
ve Windows Firewallu.

**B) USB kabel** – brýle v režimu vývojáře, nainstalované `adb`:

```bash
adb reverse tcp:5173 tcp:5173
```

Pak spusťte `npm run dev` a v brýlích otevřete `http://localhost:5173`.

Model vyberte ze seznamu *Modely ve složce models* (soubory IFC vložené do `models/` na počítači) nebo
z úložiště brýlí přes drop zónu. Pak **Vstoupit do VR** nebo **Vstoupit do AR**.

## Ovládání ve VR

| Ovladač | Akce |
|---|---|
| Levá páčka | chůze ve směru pohledu |
| Pravá páčka dopředu | teleport (oranžová parabola, červená = nejde přistát), pustit = skok |
| Pravá páčka do stran | otočení o 30° (nebo plynule, volba v Nastavení) |
| A / B | nahoru / dolů (jen bez gravitace) |
| Pravá spoušť | vybrat prvek, stisknout tlačítko na panelu |
| Pravá spoušť znovu na vybraný prvek | zrušit výběr; u dveří otevřít / zavřít |
| Pravá spoušť do půdorysu (záložka Mapa) | přesun na místo zvoleného podlaží |
| Úchop (maketa) | jednou rukou posunout, oběma otočit a zvětšit |
| X | skrýt / zobrazit panel |
| Y | přepnout Skutečné 1:1 / Maketa |

Panel ve VR má nahoře měřítko a pohled, pod nimi záložky **Modely**, **Mapa**, **Měření** a **Nastavení**
(úroveň zobrazení, pohyb, Mojžíšův mód). Volby pohybu se pamatují, výchozí je vypnuto:

- **Kolize** – chůze páčkou se zastaví před zdí (hlava 40 cm od zdi, i při chůzi podél zdi), podél zdi se klouže.
  Zdi hlídají paprsky v úrovni hrudníku a očí, nižší a tenké prvky (zábradlí, sloupky, parapety) kvádr těla
  od výšky schodu po oči (zastaví asi 30 cm před nimi). U dveří s křídly (do 80 cm od křídla) je odstup jen 15 cm,
  aby se dveřmi prošlo i mimo jejich střed. Teleport a fyzická chůze po místnosti kolize nehlídají.
- **Gravitace** – na schod nebo rampu do 45 cm se vystoupá, z vyššího místa se padá (ze schodů, do otvoru);
  podlaha se hledá pod středem a 12 cm kolem, takže se nepropadne mezerou mezi stupni otevřeného schodiště.
  Podlaha 1NP (mřížka) drží jen mimo budovu, kde pod vámi žádný model není; v budově se po schodech nebo
  otvorem dostanete i do suterénu (platí i pro teleport). A / B (nahoru / dolů) jsou s gravitací vypnuté.
- **Automatické dveře** – stejné jako volba Dveře: Automaticky na počítači; automaticky se dveře otevřou za 0,4 s
  (ručně za 0,8 s), ať jsou otevřené dřív, než k nim dojdete.
- **Plynulé otáčení** – pravá páčka do stran otáčí plynule (rychlost podle vychýlení), jinak po 30°.

## Build na statický hosting

```bash
npm run build
```

Složka `dist/` jde nahrát na libovolný HTTPS hosting (např. GitHub Pages). Seznam modelů ze složky `models/`
tam není, modely se načítají ze souboru nebo přes `?model=https://…/model.ifc`.

## Výkon

Úroveň zobrazení (v panelu na počítači i ve VR, pamatuje se v prohlížeči) mění jen to, co je vidět:

| | Kvalita | Vyvážené (výchozí) | Výkon |
|---|---|---|---|
| Rozlišení na počítači (násobek displeje, strop) | 2× | 1,5× | 1× |
| Rozlišení v brýlích | plné rozlišení displeje | 100 % | 80 % |
| Ostrost okrajů zorného pole v brýlích (foveace) | plná | snížená | snížená |
| Frekvence brýlí (Kvalita: když brýle nestíhají, samy přejdou na 72 Hz) | 90 Hz | 72 Hz | 72 Hz |
| Rubové strany ploch (pohled zevnitř zdi, plochy s otočenou normálou) | kreslí se | kreslí se | ne |
| Okna a sklo | průhledná | průhledná | neprůhledná |
| Zastínění koutů | ano | ano | ne |

Rozlišení v brýlích se změní až po dalším vstupu do VR, ostatní hned. Záhlaví panelu ve VR ukazuje snímky za sekundu a frekvenci displeje (např. „70 / 72 snímků/s“), žlutě, když brýle nestíhají. Úspory, které nejsou vidět, platí
ve všech úrovních:

- Zpracovaná geometrie se ukládá do mezipaměti prohlížeče (IndexedDB). Další otevření stejného souboru
  (stejný název, velikost a datum změny) přeskočí výpočet geometrie; IFC se pak otevře už jen kvůli
  vlastnostem prvků, na pozadí. Mezipaměť zabere nejvýš polovinu místa, které prohlížeč dovolí (max. 6 GB),
  nejdéle nepoužité modely se mažou samy; ručně ji vymaže odkaz „Vymazat mezipaměť“ v panelu.
- Na počítači se scéna kreslí jen po změně (pohyb kamery, výběr, model); ve VR každý snímek.
- Řádek „Výkon“ v panelu ukazuje snímky za sekundu, trojúhelníky a počet vykreslení.

## Omezení

- IfcSpace a otvory se nezobrazují.
- U prvků s víc než 100 otvory (typicky stropní deska s prostupy) se otvory nevyřezávají – web-ifc je odečítá
  po jednom a takový prvek by se počítal desítky minut. Aplikace na to po načtení upozorní.
- Jedna instance web-ifc má paměť nejvýš 4 GB (zhruba 1,5–2 GB souborů IFC). Když se do ní další model
  nevejde, založí se nová, takže na počítači jde načíst celou stavbu (ověřeno: 39 profesí, 3,3 GB). V brýlích
  je paměti mnohem méně.
- Velké modely (stovky MB, miliony trojúhelníků) mohou být v brýlích pomalé – vyexportujte jen potřebné profese.

## Kontakt

Lukáš Hovorka – <lukas.hovorka@energy-benefit.cz>
