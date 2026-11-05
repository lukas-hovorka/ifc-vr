# ifc.vr – prohlížeč IFC ve VR

Jednoduchá webová aplikace (WebXR) pro prohlížení modelu IFC v brýlích **Meta Quest 3**.
Běží v prohlížeči Quest Browser, do brýlí se nic neinstaluje. Na počítači funguje jako běžný 3D prohlížeč.

- načtení IFC přetažením, výběrem souboru, ze složky `models/` nebo přes `?model=adresa.ifc`
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
3. Soubor IFC si stáhněte do brýlí (např. z OneDrive / SharePointu v prohlížeči Questu) a otevřete ho
   klepnutím na drop zónu. Model se zpracuje jen v brýlích, nikam se neodesílá.

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

## Omezení

- IfcSpace a otvory se nezobrazují.
- Velké modely (stovky MB, miliony trojúhelníků) mohou být v brýlích pomalé – vyexportujte jen potřebné profese.
