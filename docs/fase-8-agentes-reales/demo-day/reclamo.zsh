# Arbiter shortcuts for the live claim at the Demo Day. Load once per terminal:
#   source ~/dev/AgentPay-demo/docs/fase-8-agentes-reales/demo-day/reclamo.zsh
# The claim Claude signs is kept at ~/Desktop/reclamo.jws; the same file is uploaded to the merchant's page.
# The scripts run from ~/dev/AgentPay, which holds .env.local.
reclamo_guardar() { pbpaste > "$HOME/Desktop/reclamo.jws" && echo "saved to ~/Desktop/reclamo.jws"; }
recibo_del_reclamo() {
  python3 -c 'import json,base64,sys
p=open(sys.argv[1]).read().strip().split(".")[1]
p+="="*(-len(p)%4)
print(json.loads(base64.urlsafe_b64decode(p))["receipt"]["hash"])' "${1:-$HOME/Desktop/reclamo.jws}"
}
reclamo_abrir() { (cd ~/dev/AgentPay && pnpm -s run resolve:open -- --claim "$HOME/Desktop/reclamo.jws"); }
reclamo_decidir() {
  local r; r="$(recibo_del_reclamo)" || return 1
  (cd ~/dev/AgentPay && pnpm -s run resolve:decide -- --receipt "$r" --response "$(ls -t "$HOME"/Downloads/agentresolve-response-*.json | head -1)")
}
reclamo_pagar() {
  local r; r="$(recibo_del_reclamo)" || return 1
  (cd ~/dev/AgentPay && pnpm -s run resolve:execute -- --receipt "$r" --confirm "$1")
}
