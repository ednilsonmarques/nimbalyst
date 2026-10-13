# Catálogo passivo do ECC

Inventário estruturado e versionado, **somente dado**, das capacidades do ECC (Everything Claude Code): agents, skills, commands, workflows, métodos (rules) e hooks. Nada no app lê estes arquivos em tempo de execução; o único consumidor é `scripts/ecc-architect-index-build.mjs`, que, em tempo de geração, deriva do JSON e de `scripts/ecc-architect-classes.json` o índice `packages/runtime/src/ai/ecc/eccCatalogIndex.generated.ts` lido pelo papel `architect` do Team Mode (classes A/B/C; hooks, memória, orquestração e entradas sem sinal nunca entram).

- `ecc-2.2.3.json`: catálogo canônico (entradas ordenadas, sem timestamps).
- `ecc-2.2.3.md`: digest legível para humanos e para prompts (a data de geração fica só aqui).

Regerar: `node scripts/ecc-catalog-build.mjs` (opções: `--ecc-root`, `--out`, `--overrides`).
A raiz padrão é resolvida por `~/.claude/plugins/installed_plugins.json` (plugin `ecc@ecc`); correções manuais ficam em `scripts/ecc-catalog.overrides.json`.

Garantias: o construtor só lê `.md/.json/.yaml/.js` como texto, sem importar, executar ou avaliar código do ECC, sem rede e sem escrever fora de `--out`.
O catálogo não habilita plugin, não registra ferramenta, não carrega hook nem MCP e não altera configuração.
Os campos `requires` e `executableInScope` são **heurísticos**, derivados do texto. `evidence` vazia (`no signals found in frontmatter or body`, com `classificationConfidence: "low"`) significa "nenhum sinal encontrado", **não** "verificado seguro": essas entradas ficam fail-closed (`read`, `review` e `write` false; `full` permanece) e a seção de read do digest lista só confiança alta. A negação real de ferramentas é feita pelo runtime (Commit A); o catálogo nunca é usado para liberar nada.

Para `kind: skill`, `executableInScope.read/review` significa que o conteúdo da skill cabe num escopo read quando injetado como texto (brief ou system prompt), nunca que a skill pode ser invocada pela ferramenta `Skill` nessas sessões: uma skill pode declarar `hooks:` no frontmatter e esse hook executa comando de shell fora da ferramenta Bash, por isso o runtime do Nimbalyst NEGA a ferramenta `Skill` em sessões read/review (`skillToolDeniedInReadReview: true`).

Para `kind: agent`, `executableInScope` diz que as ferramentas declaradas do agent cabem naquele escopo; o agent em si não é invocável em read/review, porque Agent/Task são negados pelo runtime.
