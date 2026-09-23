/**
 * Vitrinee dashboard.
 *
 * Served by the gateway itself, so every fetch is same-origin and there is no
 * configuration to get wrong on stage. No framework and no build step: the
 * page that ships is the page in the repo.
 */
const REFRESH_MS = 5000;
const EXPLORER = "https://stellar.expert/explorer/testnet";

const $ = (id) => document.getElementById(id);
const text = (value) => (value === null || value === undefined ? "—" : String(value));

/** Anything from the API is untrusted text: build nodes, never innerHTML. */
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const link = (href, label, cls = "mono") =>
  el("a", { href, target: "_blank", rel: "noopener noreferrer", className: cls }, label);

const short = (value, head = 6, tail = 6) =>
  typeof value === "string" && value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : text(value);

const time = (iso) => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "medium" });
};

const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 7 }) : text(value);
};

/** Decodes the JWS payload for display. Reading it is not verifying it. */
function decodeClaims(jws) {
  try {
    const payload = jws.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

const anchorLabel = (anchor) => {
  if (!anchor) return { cls: "muted", label: "sin anclaje" };
  if (anchor.status === "anchored") return { cls: "ok", label: "anclado" };
  if (anchor.status === "failed") return { cls: "bad", label: "falló" };
  return { cls: "pending", label: "pendiente" };
};

const platformLabel = (order) => {
  if (order.platformOrderId) return { cls: "ok", label: `#${order.platformOrderId}` };
  if (order.platformError) return { cls: "bad", label: "no se creó" };
  return { cls: "pending", label: "—" };
};

const statusCell = ({ cls, label }) => el("span", { className: cls }, [el("span", { className: "dot" }), label]);

let orders = [];

async function load() {
  $("refresh-state").textContent = "actualizando…";
  try {
    const [ordersRes, manifestRes] = await Promise.all([
      fetch("/orders", { headers: { Accept: "application/json" } }),
      fetch("/.well-known/agent-storefront.json", { headers: { Accept: "application/json" } }),
    ]);
    if (!ordersRes.ok) throw new Error(`GET /orders → ${ordersRes.status}`);
    orders = (await ordersRes.json()).orders ?? [];

    if (manifestRes.ok) {
      const manifest = await manifestRes.json();
      $("merchant-line").textContent = `${manifest.merchant.name} · ${manifest.merchant.country} · ${manifest.merchant.currency}`;
      $("net-badge").textContent = manifest.network.replace("stellar:", "");
      $("stat-products").textContent = String(manifest.products.length);
    }

    render();
    $("refresh-state").textContent = `al día ${new Date().toLocaleTimeString("es-CL")}`;
  } catch (error) {
    $("refresh-state").textContent = `sin conexión con el gateway (${error.message})`;
  }
}

function render() {
  const total = orders.reduce((sum, order) => sum + Number(order.amountUSDC ?? 0), 0);
  $("stat-orders").textContent = String(orders.length);
  $("stat-usdc").textContent = total.toLocaleString("es-CL", { maximumFractionDigits: 4 });
  $("stat-anchored").textContent = String(orders.filter((o) => o.anchor?.status === "anchored").length);

  const body = $("orders-body");
  body.replaceChildren();
  $("orders-empty").hidden = orders.length > 0;
  $("orders-table").hidden = orders.length === 0;

  for (const order of orders) {
    const row = el("tr", { tabIndex: 0 });
    row.append(
      el("td", { className: "mono" }, short(order.orderId, 10, 4)),
      el("td", {}, [
        el("div", {}, text(order.product?.name)),
        el("div", { className: "muted small mono" }, `${text(order.product?.sku)} × ${text(order.quantity)}`),
      ]),
      el("td", { className: "num" }, [
        el("div", {}, money(order.amountUSDC)),
        el("div", { className: "muted small" }, `${Number(order.totalLocal).toLocaleString("es-CL")} ${text(order.currency)}`),
      ]),
      el("td", {}, statusCell(platformLabel(order))),
      el("td", {}, order.settlement?.txHash ? link(`${EXPLORER}/tx/${order.settlement.txHash}`, short(order.settlement.txHash)) : "—"),
      el("td", {}, statusCell(anchorLabel(order.anchor))),
    );
    const open = () => showDetail(order.orderId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    body.append(row);
  }
}

function showDetail(orderId) {
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) return;
  const claims = order.receipt ? decodeClaims(order.receipt.jws) : null;
  const dialog = $("detail");
  const body = $("detail-body");

  $("detail-title").textContent = `${text(order.product?.name)} · ${text(order.quantity)} u.`;

  const kv = el("dl", { className: "kv" });
  const add = (key, value) => kv.append(el("dt", {}, key), el("dd", {}, [value]));

  add("Pedido Vitrinee", el("span", { className: "mono" }, text(order.orderId)));
  add("Creado", time(order.createdAt));
  add("Cobrado", `${money(order.amountUSDC)} USDC · ${Number(order.totalLocal).toLocaleString("es-CL")} ${text(order.currency)}`);
  add(
    `Pedido en ${text(order.platform)}`,
    order.platformOrderId
      ? el("span", { className: "mono" }, `#${order.platformOrderId}`)
      : el("span", { className: "bad" }, text(order.platformError ?? "no se creó")),
  );
  if (order.settlement?.txHash) {
    add("Transacción", link(`${EXPLORER}/tx/${order.settlement.txHash}`, order.settlement.txHash));
    // A smart account payer (C..., AgentPey's policy_rail) lives under /contract/ (VT-22).
    const payerKind = String(order.settlement.payer ?? "").startsWith("C") ? "contract" : "account";
    add("Pagador", link(`${EXPLORER}/${payerKind}/${order.settlement.payer}`, short(order.settlement.payer, 8, 8)));
    add("Recibió", link(`${EXPLORER}/account/${order.settlement.payTo}`, short(order.settlement.payTo, 8, 8)));
  }
  if (order.anchor) {
    const { label } = anchorLabel(order.anchor);
    add(
      "Anclaje",
      order.anchor.txHash
        ? el("span", {}, [`${label} · `, link(`${EXPLORER}/tx/${order.anchor.txHash}`, short(order.anchor.txHash))])
        : el("span", {}, `${label}${order.anchor.lastError ? ` · ${order.anchor.lastError}` : ""}`),
    );
    add("Registro", link(`${EXPLORER}/contract/${order.anchor.registry}`, short(order.anchor.registry, 8, 6)));
  }
  if (order.receipt) add("Hash del recibo", el("span", { className: "mono" }, order.receipt.hash));

  body.replaceChildren(kv);

  if (order.receipt) {
    const button = el("button", { className: "action", type: "button" }, "Verificar recibo");
    const result = el("div", { className: "checks" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Verificando…";
      result.replaceChildren();
      try {
        const response = await fetch(`/receipts/${order.receipt.hash}/verify`, { headers: { Accept: "application/json" } });
        renderChecks(result, await response.json());
      } catch (error) {
        result.replaceChildren(el("div", { className: "check bad" }, `No se pudo verificar: ${error.message}`));
      } finally {
        button.disabled = false;
        button.textContent = "Verificar de nuevo";
      }
    });
    body.append(el("div", { className: "section-title" }, "Verificación"), button, result);

    if (claims) {
      body.append(
        el("div", { className: "section-title" }, "Recibo firmado (claims)"),
        el("pre", { className: "claims" }, JSON.stringify(claims, null, 2)),
      );
    }
  }

  dialog.showModal();
}

const CHECK_NAMES = {
  signature: ["Firma", "El recibo lo firmó la llave del merchant que declara el manifest."],
  anchored: ["Anclaje", "Su hash está escrito en el contrato de Stellar, por ese merchant."],
  settlement: ["Pago", "La transacción existe en la red y movió ese USDC."],
};

function renderChecks(container, verification) {
  const nodes = [
    el(
      "div",
      { className: `check ${verification.valid ? "ok" : "bad"}` },
      el("div", {}, [
        el("div", { className: "check-name" }, verification.valid ? "Recibo válido" : "Recibo inválido"),
        el("div", { className: "check-why" }, verification.valid ? "Las tres comprobaciones pasaron." : "Al menos una comprobación falló."),
      ]),
    ),
  ];
  for (const [key, [name, why]] of Object.entries(CHECK_NAMES)) {
    const check = verification.checks?.[key];
    const ok = check?.ok === true;
    nodes.push(
      el("div", { className: "check" }, [
        el("span", { className: ok ? "ok" : "bad" }, ok ? "✓" : "✗"),
        el("div", {}, [el("div", { className: "check-name" }, name), el("div", { className: "check-why" }, check?.reason ?? why)]),
      ]),
    );
  }
  container.replaceChildren(...nodes);
}

load();
setInterval(load, REFRESH_MS);
