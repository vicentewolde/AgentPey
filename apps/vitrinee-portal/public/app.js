/*
 * The owners' portal (T105): sign in with Freighter (SEP-0053), register a
 * Jumpseller store, see its orders. Plain browser JavaScript, served by the
 * gateway at /portal/app.js on the platform host only.
 */
/* global freighterApi */
var PLATFORM_HOST = location.hostname;
var CHECKS = ["slug", "payout", "store", "signing"];
/* Which check each refusal belongs to; everything before it passed. */
var FAILED_CHECK = { SlugUnavailable: "slug", PayoutAccountNotReady: "payout", StoreCredentialsRejected: "store", SigningKeyNotFunded: "signing" };

var T = {
  walletMissing: { en: "Freighter was not found. Install it and reload the page.", es: "No encontramos Freighter. Instálalo y vuelve a cargar la página." },
  walletWaiting: { en: "Waiting for Freighter…", es: "Esperando a Freighter…" },
  waitingSignature: { en: "Sign the message in Freighter to prove this account is yours…", es: "Firma el mensaje en Freighter para probar que la cuenta es tuya…" },
  signinFailed: { en: "Could not sign in.", es: "No se pudo entrar." },
  signedIn: { en: "Signed in.", es: "Listo, entraste." },
  loadFailed: { en: "Could not load your stores.", es: "No se pudieron cargar tus tiendas." },
  checking: { en: "Checking…", es: "Revisando…" },
  slugAvailable: { en: "Available", es: "Disponible" },
  slug_invalid: { en: "Use lowercase letters, digits and single hyphens, up to 31 characters.", es: "Usa minúsculas, números y guiones simples, hasta 31 caracteres." },
  slug_reserved: { en: "That address is reserved by the platform.", es: "Esa dirección está reservada por la plataforma." },
  slug_taken: { en: "That address is already taken.", es: "Esa dirección ya está en uso." },
  payout_account_missing: {
    en: "Your wallet's account does not exist on Stellar testnet yet. Fund it with testnet XLM first, then try again.",
    es: "La cuenta de tu wallet todavía no existe en Stellar testnet. Fondéala con XLM de testnet y vuelve a intentarlo.",
  },
  payout_usdc_trustline_missing: {
    en: "Your wallet cannot receive USDC yet. In Freighter, add the asset USDC (issuer GBBD47…LFLA5) on testnet, then try again.",
    es: "Tu wallet todavía no puede recibir USDC. En Freighter, agrega el activo USDC (emisor GBBD47…LFLA5) en testnet y vuelve a intentarlo.",
  },
  storeRejected: { en: "Jumpseller did not accept that login and token. Copy them again from the API section of your Jumpseller admin.", es: "Jumpseller no aceptó ese login y token. Cópialos de nuevo desde la sección API de tu panel de Jumpseller." },
  signingFailed: { en: "The testnet faucet did not fund your signing key. Nothing was saved; try again in a minute.", es: "El faucet de testnet no fondeó tu llave de firma. No se guardó nada; vuelve a intentarlo en un minuto." },
  upstreamDown: { en: "Jumpseller or Stellar did not answer. Nothing was saved; try again in a minute.", es: "Jumpseller o Stellar no respondieron. No se guardó nada; vuelve a intentarlo en un minuto." },
  sessionExpired: { en: "Your session ended. Sign in again.", es: "Tu sesión terminó. Vuelve a entrar." },
  invalidForm: { en: "Fill in every field.", es: "Completa todos los campos." },
  addFailed: { en: "Could not add the store. Nothing was saved.", es: "No se pudo agregar la tienda. No se guardó nada." },
  published: { en: "Your store is live for agents at", es: "Tu tienda ya está publicada para agentes en" },
  publishedMore: {
    en: "It is in the Vitrinee directory now, and AgentPey and RealOps list it within a minute.",
    es: "Ya está en el directorio de Vitrinee, y AgentPey y RealOps la muestran en menos de un minuto.",
  },
  products: { en: "products on sale", es: "productos en venta" },
  active: { en: "Live", es: "Publicada" },
  disabled: { en: "Paused", es: "Pausada" },
  noOrders: { en: "No orders yet. When an agent buys, the order shows up here.", es: "Todavía no hay pedidos. Cuando un agente compre, el pedido aparece aquí." },
  thDate: { en: "Date", es: "Fecha" },
  thProduct: { en: "Product", es: "Producto" },
  thAmount: { en: "USDC", es: "USDC" },
  thStatus: { en: "Status", es: "Estado" },
  thProof: { en: "Proof", es: "Prueba" },
  statusPaid: { en: "Paid, order in your store", es: "Pagado, pedido en tu tienda" },
  statusUnfulfilled: { en: "Paid, order not yet in your store", es: "Pagado, pedido aún no llega a tu tienda" },
  payment: { en: "Payment", es: "Pago" },
  receipt: { en: "Receipt", es: "Recibo" },
  manifest: { en: "Catalogue for agents", es: "Catálogo para agentes" },
};

function lang() { return document.documentElement.lang === "es" ? "es" : "en"; }
function t(key) { var e = T[key]; return e ? e[lang()] : key; }

var state = { account: null, me: null, result: null, statusKey: null, statusKind: "" };

async function api(path, options) {
  var res = await fetch(path, Object.assign({ credentials: "same-origin", headers: { "content-type": "application/json" } }, options || {}));
  var body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (a proxy error page): the status says enough.
  }
  return { status: res.status, body: body || {} };
}

function setStatus(id, kind, key, text) {
  var el = document.getElementById(id);
  el.className = "status" + (kind ? " " + kind : "");
  el.textContent = key ? t(key) : text || "";
  el.dataset.key = key || "";
}

function toBase64Signature(signed) {
  if (typeof signed === "string") return signed;
  var bytes = new Uint8Array(signed);
  var binary = "";
  for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  for (var k in attrs || {}) {
    if (k === "text") node.textContent = attrs[k];
    else if (k === "className") node.className = attrs[k];
    else node.setAttribute(k, attrs[k]);
  }
  (children || []).forEach(function (c) { if (c) node.appendChild(c); });
  return node;
}

/* ---------- sign-in ---------- */
async function signIn() {
  var button = document.getElementById("signin-btn");
  if (typeof freighterApi === "undefined") return setStatus("signin-status", "err", "walletMissing");
  button.disabled = true;
  setStatus("signin-status", "", "walletWaiting");
  try {
    var presence = await freighterApi.isConnected();
    if (presence && presence.error) throw new Error(presence.error);
    var access = await freighterApi.requestAccess();
    if (access && access.error) throw new Error(access.error);
    var address = access.address || access;

    var challenge = await api("/api/portal/challenge", { method: "POST", body: JSON.stringify({ account: address }) });
    if (challenge.status !== 200) throw { body: challenge.body };
    setStatus("signin-status", "", "waitingSignature");
    var signed = await freighterApi.signMessage(challenge.body.message, { address: address });
    if (signed && signed.error) throw new Error(signed.error);
    var signature = toBase64Signature(signed.signedMessage || signed);

    var session = await api("/api/portal/session", { method: "POST", body: JSON.stringify({ account: address, nonce: challenge.body.nonce, signature: signature }) });
    if (session.status !== 200) throw { body: session.body };
    setStatus("signin-status", "ok", "signedIn");
    await loadMe();
  } catch (error) {
    setStatus("signin-status", "err", null, t("signinFailed") + " " + ((error && error.body && error.body.message) || (error && error.message) || ""));
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  await api("/api/portal/logout", { method: "POST", body: "{}" });
  state.account = null;
  state.me = null;
  state.result = null;
  setStatus("signin-status", "", null, "");
  render();
}

async function loadMe() {
  var me = await api("/api/portal/me");
  if (me.status === 401) { state.account = null; state.me = null; render(); return; }
  if (me.status !== 200) { setStatus("signin-status", "err", "loadFailed"); return; }
  state.account = me.body.account;
  state.me = me.body;
  render();
}

/* ---------- panel ---------- */
function renderStores() {
  var holder = document.getElementById("stores");
  holder.textContent = "";
  var list = (state.me && state.me.comercios) || [];
  document.getElementById("stores-empty").hidden = list.length > 0;
  list.forEach(function (c) {
    var head = el("div", { className: "store-head" }, [
      el("h3", { text: c.name }),
      el("span", { className: "pill" + (c.status === "active" ? "" : " off"), text: t(c.status === "active" ? "active" : "disabled") }),
    ]);
    var url = el("p", { className: "store-url" }, [
      el("a", { href: c.storeUrl + "/.well-known/agent-storefront.json", target: "_blank", rel: "noopener", text: c.storeUrl.replace(/^https?:\/\//, "") }),
      el("span", { className: "muted small", text: "  ·  " + t("manifest") }),
    ]);
    var box = el("div", { className: "store" }, [head, url]);
    if (!c.orders.length) {
      box.appendChild(el("p", { className: "empty", text: t("noOrders") }));
    } else {
      var rows = c.orders.map(function (o) {
        var proof = el("td", {}, [
          el("a", { href: o.paymentUrl, target: "_blank", rel: "noopener", text: t("payment") }),
          o.receiptUrl ? el("span", { text: " · " }) : null,
          o.receiptUrl ? el("a", { href: o.receiptUrl, target: "_blank", rel: "noopener", text: t("receipt") }) : null,
        ]);
        var paid = o.status === "paid";
        return el("tr", {}, [
          el("td", { text: new Date(o.createdAt).toLocaleString(lang() === "es" ? "es-CL" : "en-US", { dateStyle: "medium", timeStyle: "short" }) }),
          el("td", { text: o.product + (o.quantity > 1 ? " × " + o.quantity : "") }),
          el("td", { className: "num", text: o.amountUSDC }),
          el("td", {}, [el("span", { className: "pill" + (paid ? "" : " warn"), text: t(paid ? "statusPaid" : "statusUnfulfilled") })]),
          proof,
        ]);
      });
      var head2 = el("tr", {}, ["thDate", "thProduct", "thAmount", "thStatus", "thProof"].map(function (k) { return el("th", { text: t(k) }); }));
      box.appendChild(el("div", { className: "table-wrap" }, [el("table", {}, [el("thead", {}, [head2]), el("tbody", {}, rows)])]));
    }
    holder.appendChild(box);
  });
}

/* ---------- registration ---------- */
function slugify(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/, "");
}

var slugTouched = false;
var slugTimer = null;
var slugResult = null;

function paintSlugState() {
  var node = document.getElementById("slug-state");
  if (!slugResult) { node.className = "slug-state"; node.textContent = ""; return; }
  node.className = "slug-state " + (slugResult.available ? "ok" : "err");
  node.textContent = slugResult.available ? t("slugAvailable") : t("slug_" + slugResult.reason);
}

function checkSlugSoon() {
  clearTimeout(slugTimer);
  var slug = document.getElementById("f-slug").value.trim();
  slugResult = null;
  paintSlugState();
  if (!slug) return;
  slugTimer = setTimeout(async function () {
    var r = await api("/api/portal/slugs/" + encodeURIComponent(slug));
    if (r.status === 200 && document.getElementById("f-slug").value.trim() === slug) { slugResult = r.body; paintSlugState(); }
  }, 350);
}

function paintChecks(failed, running) {
  var list = document.getElementById("checks");
  list.hidden = false;
  var failedAt = failed ? CHECKS.indexOf(failed) : -1;
  CHECKS.forEach(function (name, i) {
    var li = list.querySelector('[data-check="' + name + '"]');
    var icon = li.querySelector(".icon");
    // The server runs the four checks in one call, so while it works all four are pending.
    var kind = running ? "running" : failed === null ? "ok" : failedAt === -1 ? "" : i < failedAt ? "ok" : i === failedAt ? "fail" : "";
    li.className = kind;
    icon.textContent = kind === "ok" ? "✓" : kind === "fail" ? "!" : "";
  });
}

function refusalMessage(body) {
  var code = body && body.error;
  var details = (body && body.details) || {};
  if (code === "SlugUnavailable") return t("slug_" + (details.reason || "invalid"));
  if (code === "PayoutAccountNotReady") return t("payout_" + (details.reason || "account_missing"));
  if (code === "StoreCredentialsRejected") return t("storeRejected");
  if (code === "SigningKeyNotFunded") return t("signingFailed");
  if (code === "AdapterError" || code === "NetworkError") return t("upstreamDown");
  if (code === "SessionRequired") return t("sessionExpired");
  if (code === "ValidationError") return t("invalidForm");
  return t("addFailed");
}

function paintResult() {
  var node = document.getElementById("add-result");
  var r = state.result;
  if (!r) { node.hidden = true; return; }
  node.hidden = false;
  node.textContent = "";
  if (r.ok) {
    node.className = "notice";
    node.appendChild(document.createTextNode(t("published") + " "));
    node.appendChild(el("a", { href: r.body.comercio.storeUrl + "/.well-known/agent-storefront.json", target: "_blank", rel: "noopener", text: r.body.comercio.storeUrl.replace(/^https?:\/\//, "") }));
    node.appendChild(document.createTextNode(" (" + r.body.products + " " + t("products") + "). " + t("publishedMore")));
  } else {
    node.className = "notice err";
    node.textContent = refusalMessage(r.body);
  }
}

async function addStore(event) {
  event.preventDefault();
  var name = document.getElementById("f-name").value.trim();
  var slug = document.getElementById("f-slug").value.trim();
  var login = document.getElementById("f-login").value.trim();
  var token = document.getElementById("f-token").value.trim();
  state.result = null;
  paintResult();
  if (!name || !slug || !login || !token) { state.result = { ok: false, body: { error: "ValidationError" } }; paintResult(); return; }

  var button = document.getElementById("add-btn");
  button.disabled = true;
  paintChecks(null, true);
  try {
    var r = await api("/api/portal/comercios", {
      method: "POST",
      body: JSON.stringify({ name: name, slug: slug, credentials: { kind: "jumpseller-api", login: login, authtoken: token } }),
    });
    if (r.status === 201) {
      paintChecks(null, false);
      state.result = { ok: true, body: r.body };
      document.getElementById("add-form").reset();
      slugTouched = false;
      slugResult = null;
      paintSlugState();
      await loadMe();
    } else {
      var failed = FAILED_CHECK[r.body && r.body.error];
      if (failed) paintChecks(failed, false);
      else document.getElementById("checks").hidden = true;
      state.result = { ok: false, body: r.body };
      if (r.status === 401) await loadMe();
    }
  } catch {
    document.getElementById("checks").hidden = true;
    state.result = { ok: false, body: {} };
  } finally {
    // The token is never kept on the page once it was sent.
    document.getElementById("f-token").value = "";
    button.disabled = false;
    paintResult();
  }
}

/* ---------- page ---------- */
function render() {
  var signedIn = !!state.account;
  document.getElementById("signin-actions").hidden = signedIn;
  document.getElementById("signed-in").hidden = !signedIn;
  document.getElementById("account").textContent = state.account || "";
  document.getElementById("account").title = state.account || "";
  document.getElementById("stores-panel").hidden = !signedIn;
  document.getElementById("add-panel").hidden = !signedIn;
  if (signedIn) renderStores();
  paintSlugState();
  paintResult();
  var status = document.getElementById("signin-status");
  if (status.dataset.key) status.textContent = t(status.dataset.key);
}

document.getElementById("slug-suffix").textContent = "." + PLATFORM_HOST;
document.getElementById("signin-btn").addEventListener("click", signIn);
document.getElementById("signout-btn").addEventListener("click", signOut);
document.getElementById("add-form").addEventListener("submit", addStore);
document.getElementById("f-name").addEventListener("input", function () {
  if (slugTouched) return;
  document.getElementById("f-slug").value = slugify(this.value);
  checkSlugSoon();
});
document.getElementById("f-slug").addEventListener("input", function () {
  slugTouched = true;
  checkSlugSoon();
});
document.addEventListener("agentpey:lang", render);
loadMe();
