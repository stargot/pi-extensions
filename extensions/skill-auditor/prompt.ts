/**
 * Semantic review prompt for the skill-auditor extension (T6): wraps the
 * deterministic mechanical report (buildReport in ./report.ts) into a user
 * message that the `/audit go` verb injects via `pi.sendUserMessage`. Pure
 * module: two strings in (report, cwd), one string out — no fs, no pi
 * imports, and two identical calls always yield byte-identical output.
 *
 * The prompt (in Russian) embeds the mechanical report verbatim plus the
 * session cwd and asks the model for recommendations in exactly three
 * sections: (1) description routing quality — which skills the model is
 * unlikely to select on its own and how to strengthen the "use when" part;
 * (2) overlaps and duplicates between skills; (3) candidates to move from
 * the global scope into this project's `.agents/skills` and candidates for
 * `disable-model-invocation: true`, grounded in the scope map and findings.
 * Every recommendation must be a single line in the "name → действие →
 * почему" form. The extension's read-only contract is repeated explicitly:
 * recommendations only — skill files are never moved, edited or deleted.
 */
export function buildSemanticPrompt(report: string, cwd: string): string {
	return `Ты — эксперт по промпт-роутингу скиллов агента pi. Ниже — механический отчёт расширения skill-auditor (read-only аудит: валидность frontmatter, роутинг-триггеры, ссылки, карта скоупов «глобал vs проект»). Рабочая директория текущей сессии: \`${cwd}\`.

\`\`\`markdown
${report}
\`\`\`

Разбери отчёт семантически и выдай рекомендации — ровно три секции:

1. **Качество роутинга description.** Для каждого скилла, который модель вряд ли выберет сама, объясни почему (нет «use when»-триггеров, слишком общая формулировка, триггеры тонут среди других скиллов) и предложи, как усилить «use when»-часть description. Опирайся на находки \`vague-description\` и \`skill-unloadable\`.
2. **Пересечения и дубли.** Найди скиллы с перекрывающимися description; для каждой пары укажи, какой скилл оставить ведущим, какой сузить или слить с ним.
3. **Скоуп.** Опираясь на карту скоупов и находки, назови кандидатов на перенос из глобальных скиллов в проектные \`.agents/skills\` для указанного cwd (скилл нужен только этому проекту) и кандидатов на \`disable-model-invocation: true\` (скилл должен запускаться только вручную командой, а не по решению модели).

Жёсткие правила:
- Выдаёшь ТОЛЬКО текстовые рекомендации. Файлы скиллов не двигать, не править, не удалять; команд над ними не запускать.
- Не выдумывай скиллы, которых нет в отчёте: каждое предложение обосновывай его данными (карта скоупов, находки, description).

Формат ответа: три markdown-секции по задачам выше; каждая рекомендация — одна строка в виде «name → действие → почему»; если кандидатов в секции нет — одна строка «нет кандидатов».
`;
}
