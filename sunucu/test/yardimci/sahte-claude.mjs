#!/usr/bin/env node
// Testler için sahte `claude` komutu. Gerçek claude -p'nin JSON çıktısını taklit eder.
// İstemdeki "SENARYO:<ad>" hangi davranışın seçileceğini belirler. SAHTE_KAYIT verilirse
// her çağrının argümanları, ilgili ortam değişkenleri ve istemi o dosyaya JSON satırı olarak eklenir.
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(`Usage: claude [options] [prompt]
Options:
  -p, --print                         Print response and exit
  --output-format <format>            text, json, stream-json
  --model <model>                     Model for the session
  --system-prompt <prompt>            System prompt
  --append-system-prompt <prompt>     Append to the default system prompt
  --tools <tools...>                  Built-in tools available
  --allowedTools, --allowed-tools <tools...>
  --disallowedTools, --disallowed-tools <tools...>
  --permission-mode <mode>            Permission mode
  --no-session-persistence            Do not save the session
  --max-budget-usd <amount>           Spend limit
  --json-schema <schema>              Structured output schema
  --effort <level>                    Reasoning effort`);
  process.exit(0);
}

const IZLENEN = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

let istem = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { istem += d; });
process.stdin.on("end", () => {
  if (process.env.SAHTE_KAYIT) {
    const env = Object.fromEntries(IZLENEN.map((ad) => [ad, process.env[ad] ?? null]));
    fs.appendFileSync(process.env.SAHTE_KAYIT, JSON.stringify({ args, env, istem, cwd: process.cwd() }) + "\n");
  }
  const senaryo = (/SENARYO:(\w+)/.exec(istem) ?? [])[1] ?? "tamam";
  const yaz = (v, kod = 0) => { process.stdout.write(JSON.stringify(v) + "\n"); process.exit(kod); };
  switch (senaryo) {
    case "tamam":
      return yaz({
        type: "result", subtype: "success", is_error: false, result: "İş tamam.", total_cost_usd: 0.0123, num_turns: 3,
        usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 20 },
        permission_denials: [{ tool_name: "Bash", tool_input: { command: "curl https://ornek.invalid" } }],
      });
    case "yapisal":
      return yaz({
        type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.002, num_turns: 1, usage: {},
        structured_output: { karar: "SORU", gerekce: "karar gerekli", bulgular: [], sorular: [] },
      });
    case "metinden":
      return yaz({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {},
        result: 'İnceledim.\n```json\n{"karar": "DUZELT", "gerekce": "eksik", "bulgular": ["K2 yok"]}\n```' });
    case "giris":
      return yaz({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", usage: {} }, 1);
    case "yogun":
      return yaz({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded_error", usage: {} }, 1);
    case "butce":
      return yaz({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "", usage: {} }, 1);
    case "bozuk":
      process.stdout.write("bu JSON değil\n");
      process.exit(2);
      break;
    case "uyku":
      setInterval(() => {}, 1000);   // süre sınırını beklesin
      break;
    default:
      return yaz({ type: "result", subtype: "success", is_error: false, result: `bilinmeyen senaryo ${senaryo}`, usage: {} });
  }
});
