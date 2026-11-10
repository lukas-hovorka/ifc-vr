# ifc.vr – prohlížeč IFC ve VR

Jednoduchá webová aplikace (WebXR) pro prohlížení modelu IFC v brýlích **Meta Quest 3**.
Běží v prohlížeči Quest Browser, do brýlí se nic neinstaluje. Na počítači funguje jako běžný 3D prohlížeč.

- načtení IFC přetažením, výběrem souboru, ze složky `models/` nebo přes `?model=a.ifc&model=b.ifc`
- **více modelů najednou** (např. profese stavby): sedí na sebe podle souřadnic prvního modelu; model se
  souřadnicemi dál než 10 km se umístí do počátku. Načtené modely jde jednotlivě skrýt, přebarvit jednou
  barvou (kolečko vedle názvu, opakovaným klepnutím se střídají barvy a původní barvy z IFC) a odebrat –
  na počítači v panelu vlevo, ve VR na záložce **Modely** panelu u levé ruky (tam i *Přidat soubor*,
  které ukončí VR a otevře výběr souborů)
- **VR 1:1**: procházení modelem ve skutečné velikosti (teleport, chůze, let nahoru/dolů)
- **Maketa / AR**: zmenšený model před vámi, v AR na stole v reálném prostoru (průhled kamer Quest 3);
  úchopem se posouvá, oběma rukama otáčí a zvětšuje
- výběr prvku a jeho vlastnosti (typ, podlaží, GlobalId, sady vlastností a množství) na panelu u levé ruky

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
| Pravá páčka do stran | otočení o 30° |
| A / B | nahoru / dolů |
| Pravá spoušť | vybrat prvek, stisknout tlačítko na panelu |
| Úchop (maketa) | jednou rukou posunout, oběma otočit a zvětšit |
| X | skrýt / zobrazit panel |
| Y | přepnout Skutečné 1:1 / Maketa |

## Build na statický hosting

```bash
npm run build
```

Složka `dist/` jde nahrát na libovolný HTTPS hosting (např. GitHub Pages). Seznam modelů ze složky `models/`
tam není, modely se načítají ze souboru nebo přes `?model=https://…/model.ifc`.

## Výkon

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
