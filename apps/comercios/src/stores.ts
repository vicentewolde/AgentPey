/**
 * The stores in the demo. Platforms were read from each site's HTML on
 * 2026-11-11. "piloto" stores told Vicente yes and allowed the use of their
 * catalogue; "black-friday" stores are listed on blackfriday.cl (27–30 Nov 2026)
 * and are only diagnosed from public data until they say yes.
 */
import type { Store } from "./model.js";

export const STORES: readonly Store[] = [
  { id: "bestmart", name: "Bestmart", origin: "https://bestmart.cl", platform: "shopify", rubro: "tecnología", source: "piloto", sellsOnline: true },
  { id: "csbyte", name: "CSBYTE", origin: "https://csbyte.cl", platform: "shopify", rubro: "tecnología reacondicionada", source: "piloto", sellsOnline: true },
  { id: "pethome", name: "PetHome", origin: "https://pethome.cl", platform: "shopify", rubro: "mascotas", source: "piloto", sellsOnline: true },
  { id: "homemobili", name: "Home Mobili", origin: "https://homemobili.cl", platform: "shopify", rubro: "muebles", source: "piloto", sellsOnline: true },
  { id: "felinus", name: "Felinus", origin: "https://felinus.cl", platform: "prestashop", rubro: "gatos", source: "piloto", sellsOnline: true },
  { id: "luminova", name: "Luminova", origin: "https://luminova.cl", platform: "propia", rubro: "iluminación LED arquitectónica", source: "piloto", sellsOnline: false },

  { id: "bpets", name: "B-Pets", origin: "https://www.bpets.cl", platform: "vtex", rubro: "mascotas", source: "black-friday", sellsOnline: true },
  { id: "braloy", name: "Mascotas Braloy", origin: "https://braloy.cl", platform: "prestashop", rubro: "mascotas", source: "black-friday", sellsOnline: true },
  { id: "tusmascotas", name: "TusMascotas.cl", origin: "https://www.tusmascotas.cl", platform: "woocommerce", rubro: "mascotas", source: "black-friday", sellsOnline: true },
  { id: "michis", name: "Todo para tus Michis", origin: "https://www.todoparatusmichis.cl", platform: "jumpseller", rubro: "gatos", source: "black-friday", sellsOnline: true },
  { id: "dlphone", name: "DL Phone", origin: "https://dlphone.cl", platform: "shopify", rubro: "tecnología", source: "black-friday", sellsOnline: true },
  { id: "hifi", name: "HiFi", origin: "https://hifi.cl", platform: "shopify", rubro: "audio", source: "black-friday", sellsOnline: true },
  { id: "reuse", name: "Reuse", origin: "https://www.reuse.cl", platform: "shopify", rubro: "tecnología reacondicionada", source: "black-friday", sellsOnline: true },
  { id: "entremusicos", name: "EntreMúsicos", origin: "https://entremusicos.cl", platform: "woocommerce", rubro: "instrumentos musicales", source: "black-friday", sellsOnline: true },
  { id: "osoji", name: "Osoji", origin: "https://osoji.cl", platform: "woocommerce", rubro: "robots de limpieza y cocina", source: "black-friday", sellsOnline: true },
  { id: "tehtools", name: "TEH Tools", origin: "https://www.tehtools.cl", platform: "shopify", rubro: "herramientas", source: "black-friday", sellsOnline: true },
  { id: "laherramienta", name: "LaHerramienta.cl", origin: "https://www.laherramienta.cl", platform: "vtex", rubro: "herramientas", source: "black-friday", sellsOnline: true },
  { id: "mundoamable", name: "Mundo Amable", origin: "https://mundoamable.cl", platform: "woocommerce", rubro: "productos sensoriales y de motricidad", source: "black-friday", sellsOnline: true },
  { id: "sokobox", name: "Sokobox", origin: "https://sokobox.cl", platform: "shopify", rubro: "belleza", source: "black-friday", sellsOnline: true },
  { id: "kallfu", name: "Kallfu", origin: "https://kallfu.cl", platform: "shopify", rubro: "alimentos", source: "black-friday", sellsOnline: true },
  { id: "pichintun", name: "Pichintún", origin: "https://www.pichintun.com", platform: "shopify", rubro: "infantil", source: "black-friday", sellsOnline: true },
  { id: "extravirgen", name: "Extravirgen.Store", origin: "https://www.extravirgen.store", platform: "shopify", rubro: "aceite de oliva", source: "black-friday", sellsOnline: true },
];

export function findStore(id: string): Store {
  const s = STORES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no hay una tienda "${id}". Las que hay: ${STORES.map((x) => x.id).join(", ")}`);
  return s;
}
