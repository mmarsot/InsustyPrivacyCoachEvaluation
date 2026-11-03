# README assets

Images the root README shows. Each comes in a light and a dark version,
picked by a `<picture>` element, since GitHub strips CSS from READMEs.

| File | What it is | How to remake it |
| --- | --- | --- |
| `headline-light.svg`, `headline-dark.svg` | The Results chart: Insusty against Presidio on rule-based detection | `npm run readme:chart` ([`../readme-chart.ts`](../readme-chart.ts)). Its numbers are the ones the README's Results table quotes: after a new measurement, update `HEADLINE` there and the README together; `npm test` fails while the two disagree or the SVGs are stale. |
| `banner-light.png`, `banner-dark.png` | The header banner | Render `banner.html` (`?theme=light` and `?theme=dark`) at 1280×320 with a transparent background, for example `google-chrome --headless=new --window-size=1280,320 --default-background-color=00000000 --screenshot=… "file://…/banner.html?theme=dark"`, then reduce to 256 colours. It loads Poppins and Inter from Google Fonts. |
| `insusty-logo.png` | Poka, the Insusty dog, on its plum disc (256 px) | A copy of `src/popup/assets/insusty_dog_logo_circle_transparent.png` in the extension repository (`mmarsot/InsustyPromptCoach`), reduced to 256 px and 256 colours. Copy it again if the extension's logo changes. |

The colours are the Insusty brand kit's ("Sunset"): plum `#4A1F42` and
`#3A1834`, coral `#FF6B4A` (text-safe `#C23F26`), amber `#FFA940` (text-safe
`#B8720E`), peach `#FFF3EA`, ink `#3D2420` and `#7A5A50`, line `#F0DDD0`. The
logo is the dog, never a wordmark.
