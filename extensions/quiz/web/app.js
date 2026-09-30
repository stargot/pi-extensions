/**
 * quiz web page (step 4 of the web-quiz plan).
 *
 * Lifecycle: polls GET api/v1/state?t=… once per second (skips the fetch while
 * document.hidden; polls immediately on visibilitychange), renders the pending
 * question — Markdown via marked, LaTeX via KaTeX auto-render, diagrams via
 * mermaid, all pinned CDN builds loaded with SRI — and POSTs the answer back
 * via POST api/v1/answer. After an answer the same poll delivers the graded
 * feedback, which stays on screen until the server arms the next question:
 * the tab is reused for the whole session (idle = "waiting for a question").
 *
 * Degradation: any CDN asset that fails to load or fails its SRI integrity
 * check is reported in a banner and the affected rendering step is skipped
 * (plain text); the form is plain DOM and answering always works offline.
 *
 * Paths: every API call uses a RELATIVE path (the document URL ends in
 * ?t=<token>, so root-absolute paths would resolve fine here, but relative
 * keeps working even if the page is ever mounted under a sub-path) and
 * re-appends the token explicitly to every request.
 *
 * XSS posture: question/option/explanation text is HTML-escaped BEFORE
 * markdown parsing, so no raw HTML from the question can reach innerHTML —
 * the only tags in the output are the ones marked itself generates. Math
 * spans are re-inserted as text nodes, and mermaid runs with
 * securityLevel "strict". Links with a javascript: URL would still be blocked
 * by the server's CSP (script-src without 'unsafe-inline').
 */
(() => {
	// ── pinned CDN assets + SRI ────────────────────────────────────────────────────
	// Hashes are sha384 over the exact bytes jsdelivr serves for these immutable
	// versioned URLs (computed at implementation time). SRI turns any CDN
	// tampering into a load failure → degradation path, not code execution.
	const CDN_LIBS = [
		{
			key: "marked",
			src: "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
			integrity: "sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi",
		},
		{
			key: "katex",
			src: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
			integrity: "sha384-7zkQWkzuo3B5mTepMUcHkMB5jZaolc2xDwL6VFqjFALcbeS9Ggm/Yr2r3Dy4lfFg",
		},
		{
			key: "autoRender",
			src: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
			integrity: "sha384-43gviWU0YVjaDtb/GhzOouOXtZMP/7XUzwPTstBeZFe/+rCMvRwr4yROQP43s0Xk",
		},
		// RESOLVED RISK (plan, step 4): mermaid@11.12.1 ships a self-contained
		// esbuild IIFE bundle at dist/mermaid.min.js (verified: no `import(`, no
		// script-injection chunk loader; everything up to the final
		// `globalThis["mermaid"] = …` assignment is inlined), so it works with SRI.
		{
			key: "mermaid",
			src: "https://cdn.jsdelivr.net/npm/mermaid@11.12.1/dist/mermaid.min.js",
			integrity: "sha384-LlKSgo4Eo5GuF/ZrstLti44dE+GC5XAJ7TSu0Nw9Q3vIZF2QMnkRcK7BUoLabYLF",
		},
	];
	const KATEX_CSS = {
		src: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
		integrity: "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+",
	};

	const POLL_MS = 1000;
	const MATH_PLACEHOLDER_RE = /%%MATH(\d+)%%/g;

	// ── DOM handles ────────────────────────────────────────────────────────────
	const el = {
		banner: document.getElementById("banner"),
		question: document.getElementById("question"),
		context: document.getElementById("context"),
		status: document.getElementById("status"),
		notice: document.getElementById("notice"),
		form: document.getElementById("form"),
		options: document.getElementById("options"),
		dontKnow: document.getElementById("dont-know"),
		dontKnowLabel: document.getElementById("dont-know-label"),
		note: document.getElementById("note"),
		submit: document.getElementById("submit"),
		feedback: document.getElementById("feedback"),
		footer: document.getElementById("footer"),
	};

	// ── state ──────────────────────────────────────────────────────────────────
	const token = new URLSearchParams(location.search).get("t") ?? "";
	const stateUrl = `api/v1/state?t=${encodeURIComponent(token)}`;
	const answerUrl = `api/v1/answer?t=${encodeURIComponent(token)}`;

	/** key → "ok" | "failed"; missing = still loading. */
	const libState = {};
	let libsSettled = false;
	let stopped = false; // fatal (token rejected) — stop polling
	let lastState = null; // last received state object
	let lastStateJson = null; // JSON of the state currently on screen
	let lastRenderHadFullLibs = false;
	let pollTimeout = null;
	let submitting = false;

	// ── library loading ────────────────────────────────────────────────────────
	function loadScript(asset) {
		return new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = asset.src;
			script.integrity = asset.integrity;
			script.crossOrigin = "anonymous";
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`failed to load ${asset.key} from CDN`));
			document.head.appendChild(script);
		});
	}

	function loadLibs() {
		// KaTeX fonts/typography: fire-and-forget (a failed stylesheet only means
		// unstyled math; banner reporting below covers the JS failures).
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = KATEX_CSS.src;
		link.integrity = KATEX_CSS.integrity;
		link.crossOrigin = "anonymous";
		document.head.appendChild(link);

		const loads = CDN_LIBS.map((asset) =>
			loadScript(asset).then(
				() => {
					libState[asset.key] = "ok";
				},
				() => {
					libState[asset.key] = "failed";
				},
			),
		);
		Promise.all(loads).then(() => {
			libsSettled = true;
			if (window.mermaid) {
				try {
					const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
					window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
				} catch {
					libState.mermaid = "failed";
				}
			}
			updateBanner();
			// If the first render happened before the libs arrived, re-render now.
			if (lastState && lastState.kind !== "idle" && !lastRenderHadFullLibs) renderState(lastState);
		});
	}

	function updateBanner() {
		const failed = CDN_LIBS.filter((a) => libState[a.key] === "failed").map((a) => a.key);
		if (failed.length === 0) {
			el.banner.hidden = true;
			el.banner.textContent = "";
			return;
		}
		el.banner.hidden = false;
		el.banner.textContent =
			`Enhanced rendering unavailable (CDN unreachable: ${failed.join(", ")}). ` +
			"Showing plain text — you can still answer normally.";
	}

	// ── rendering helpers ──────────────────────────────────────────────────────
	function escapeHtml(text) {
		return text.replace(/[&<>"']/g, (ch) => {
			switch (ch) {
				case "&":
					return "&amp;";
				case "<":
					return "&lt;";
				case ">":
					return "&gt;";
				case '"':
					return "&quot;";
				default:
					return "&#39;";
			}
		});
	}

	const DISPLAY_MATH_RE = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g;
	const INLINE_MATH_RE = /\\\([\s\S]+?\\\)|\$(?!\s)(?:\\.|[^$\n\\])+?\$/g;

	/**
	 * Pull math spans out of the raw text BEFORE markdown runs, so marked can
	 * never mangle LaTeX (`\\`, `&`, `_`…) and KaTeX still sees the original
	 * source when the placeholders are restored as text nodes.
	 */
	function protectMath(text) {
		const spans = [];
		const store = (match) => {
			spans.push(match);
			return `%%MATH${spans.length - 1}%%`;
		};
		const out = text.replace(DISPLAY_MATH_RE, store).replace(INLINE_MATH_RE, (match, offset, string) => {
			if (match.startsWith("$")) {
				const inner = match.slice(1, -1);
				// pandoc guards for single-$: closing $ not preceded by
				// whitespace and not followed by a digit → "$5 and $10" stays literal
				if (/\s/.test(inner.slice(-1)) || /\d/.test(string[offset + match.length] ?? "")) return match;
			}
			return store(match);
		});
		return { out, spans };
	}

	function plainTextHtml(escaped) {
		// Degraded renderer: paragraphs + <br>, nothing else.
		return `<p>${escaped
			.split(/\n{2,}/)
			.map((part) => part.replace(/\n/g, "<br>"))
			.join("</p><p>")}</p>`;
	}

	function restoreMath(root, spans) {
		if (spans.length === 0) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes = [];
		while (walker.nextNode()) nodes.push(walker.currentNode);
		for (const node of nodes) {
			const data = node.nodeValue;
			if (!data.includes("%%MATH")) continue;
			node.parentNode.replaceChild(splitOnPlaceholders(data, spans), node);
		}
	}

	/** Split a text node's value on %%MATHn%% placeholders; math becomes real text nodes. */
	function splitOnPlaceholders(data, spans) {
		const fragment = document.createDocumentFragment();
		let cursor = 0;
		MATH_PLACEHOLDER_RE.lastIndex = 0;
		let match = MATH_PLACEHOLDER_RE.exec(data);
		while (match !== null) {
			if (match.index > cursor) fragment.appendChild(document.createTextNode(data.slice(cursor, match.index)));
			fragment.appendChild(document.createTextNode(spans[Number(match[1])] ?? ""));
			cursor = match.index + match[0].length;
			match = MATH_PLACEHOLDER_RE.exec(data);
		}
		if (cursor < data.length) fragment.appendChild(document.createTextNode(data.slice(cursor)));
		return fragment;
	}

	async function renderMermaidBlocks(root) {
		if (!window.mermaid || libState.mermaid !== "ok") return;
		const codes = root.querySelectorAll("pre > code.language-mermaid");
		if (codes.length === 0) return;
		const nodes = [];
		for (const code of codes) {
			const pre = code.parentElement;
			const div = document.createElement("div");
			div.className = "mermaid";
			div.textContent = code.textContent;
			pre.replaceWith(div);
			nodes.push(div);
		}
		try {
			await window.mermaid.run({ nodes });
		} catch {
			// mermaid renders its own error bubble inside the node; keep the page alive
		}
	}

	/** Markdown + KaTeX + mermaid pipeline for one text block. */
	function renderRich(target, text) {
		const { out, spans } = protectMath(text);
		const escaped = escapeHtml(out);
		let html;
		if (libState.marked === "ok" && window.marked?.parse) {
			try {
				html = window.marked.parse(escaped);
			} catch {
				html = plainTextHtml(escaped);
			}
		} else {
			html = plainTextHtml(escaped);
		}
		target.innerHTML = html;
		restoreMath(target, spans);
		if (libState.katex === "ok" && window.renderMathInElement) {
			try {
				window.renderMathInElement(target, {
					delimiters: [
						{ left: "$$", right: "$$", display: true },
						{ left: "\\[", right: "\\]", display: true },
						{ left: "\\(", right: "\\)", display: false },
						{ left: "$", right: "$", display: false },
					],
					throwOnError: false,
				});
			} catch {
				// malformed math stays as plain text
			}
		}
		renderMermaidBlocks(target);
	}

	function setVisibility(stateKind) {
		const pending = stateKind === "pending";
		el.question.hidden = stateKind === "idle";
		el.context.hidden = stateKind !== "pending" && stateKind !== "feedback";
		el.form.hidden = !pending;
		el.feedback.hidden = stateKind !== "feedback";
		el.footer.hidden = false;
	}

	function renderOptionList(container, state, marks) {
		container.replaceChildren();
		for (const option of state.options) {
			const row = document.createElement("div");
			row.className = "fb-option";
			const mark = marks ? marks(option) : { mark: " ", cls: "" };
			row.classList.add(mark.cls || "dim-opt");
			const num = document.createElement("span");
			num.className = "opt-num";
			num.textContent = `${option.index}.`;
			const glyph = document.createElement("span");
			glyph.className = "mark";
			glyph.textContent = mark.mark;
			const body = document.createElement("span");
			body.className = "opt-body rich";
			renderRich(body, option.label);
			row.append(glyph, num, body);
			container.appendChild(row);
		}
	}

	// ── state renderers ────────────────────────────────────────────────────────
	function renderIdle() {
		setVisibility("idle");
		el.status.hidden = false;
		el.status.textContent = "Waiting for a question…";
		el.notice.hidden = true;
	}

	function renderPending(state) {
		const noteBefore = el.note.value;
		setVisibility("pending");
		el.status.hidden = true;
		el.notice.hidden = true;
		el.question.replaceChildren();
		renderRich(el.question, state.question);
		if (state.context) {
			el.context.replaceChildren();
			renderRich(el.context, state.context);
		}

		const multi = state.mode === "multi-select";
		el.options.replaceChildren();
		for (const option of state.options) {
			const label = document.createElement("label");
			label.className = "option";
			const input = document.createElement("input");
			input.type = multi ? "checkbox" : "radio";
			input.name = "answer";
			input.value = String(option.index);
			input.dataset.index = String(option.index);
			input.dataset.label = option.label;
			const num = document.createElement("span");
			num.className = "opt-num";
			num.textContent = `${option.index}.`;
			const body = document.createElement("span");
			body.className = "opt-body rich";
			renderRich(body, option.label);
			label.append(input, num, body);
			el.options.appendChild(label);
		}
		el.dontKnow.checked = false;
		el.dontKnowLabel.textContent = state.dontKnowLabel;
		el.note.value = noteBefore; // survive lib-arrival re-renders of the same question
		el.submit.disabled = true;
		el.submit.textContent = "Submit";
	}

	function feedbackMarks(state) {
		return (option) => {
			const selected = state.selectedIndices.includes(option.index);
			const key = state.correctIndices.includes(option.index);
			if (state.dontKnow) return key ? { mark: "✓", cls: "hit" } : { mark: "", cls: "dim-opt" };
			if (selected && key) return { mark: "✓", cls: "hit" };
			if (selected && !key) return { mark: "✗", cls: "miss" };
			if (!selected && key) return { mark: "✓", cls: "hit" };
			return { mark: "", cls: "dim-opt" };
		};
	}

	function renderFeedback(state) {
		setVisibility("feedback");
		el.status.hidden = true;
		el.notice.hidden = true;

		const verdict = document.createElement("p");
		verdict.className = "verdict";
		if (state.dontKnow) {
			verdict.classList.add("dontknow");
			verdict.textContent = `You said: ${state.dontKnowLabel}`;
		} else if (state.correct) {
			verdict.classList.add("ok");
			verdict.textContent = "✓ Correct!";
		} else {
			verdict.classList.add("bad");
			verdict.textContent = "✗ Incorrect.";
		}
		el.feedback.replaceChildren(verdict);

		renderOptionList(el.feedback, state, feedbackMarks(state));

		const correctLine = document.createElement("p");
		correctLine.className = "correct-line";
		correctLine.textContent = `Correct answer: ${state.correctIndices
			.map((i) => {
				const opt = state.options.find((o) => o.index === i);
				return opt ? `${i}. ${opt.label}` : String(i);
			})
			.join(", ")}`;
		el.feedback.appendChild(correctLine);

		if (state.note) {
			const noteLine = document.createElement("p");
			noteLine.className = "note-line";
			noteLine.textContent = `Your note: ${state.note}`;
			el.feedback.appendChild(noteLine);
		}

		if (state.explanation) {
			const box = document.createElement("div");
			box.className = "explanation rich";
			renderRich(box, state.explanation);
			el.feedback.appendChild(box);
		}
	}

	function renderState(state) {
		lastStateJson = JSON.stringify(state);
		lastRenderHadFullLibs = libsSettled;
		document.title =
			state.kind === "pending" ? "quiz — question" : state.kind === "feedback" ? "quiz — answered" : "quiz";
		if (state.kind === "idle") renderIdle();
		else if (state.kind === "pending") renderPending(state);
		else renderFeedback(state);
	}

	/**
	 * Re-render only on change: during a pending question the poll must NOT
	 * rebuild the form (it would wipe the note the user is typing). A lib
	 * upgrade (plain-text → rich) forces one re-render of the same state.
	 */
	function renderIfChanged(state) {
		const json = JSON.stringify(state);
		const unchanged = json === lastStateJson && (libsSettled === lastRenderHadFullLibs || state.kind === "idle");
		if (unchanged) return;
		renderState(state);
	}

	// ── polling ────────────────────────────────────────────────────────────────
	function schedulePoll() {
		if (stopped) return;
		pollTimeout = setTimeout(poll, POLL_MS);
	}

	async function poll() {
		if (stopped || document.hidden) {
			schedulePoll();
			return;
		}
		try {
			const res = await fetch(stateUrl, { cache: "no-store" });
			if (res.status === 200) {
				const state = await res.json();
				lastState = state;
				renderIfChanged(state);
			} else if (res.status === 403) {
				stopped = true;
				el.status.hidden = false;
				el.status.textContent = "This page's access token was rejected. Reopen the URL printed in the pi transcript.";
				setVisibility("idle");
			}
		} catch {
			// server briefly unreachable — keep polling, the page may be reused
		}
		schedulePoll();
	}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && !stopped) {
			if (pollTimeout !== null) clearTimeout(pollTimeout);
			poll();
		}
	});

	// ── answering ──────────────────────────────────────────────────────────────
	function showNotice(text) {
		el.notice.hidden = false;
		el.notice.textContent = text;
	}

	function collectAnswer() {
		const note = el.note.value.trim();
		if (el.dontKnow.checked) {
			return { dontKnow: true, note: note || undefined, answers: [] };
		}
		const answers = [...el.options.querySelectorAll("input[name='answer']:checked")].map((input) => ({
			label: input.dataset.label,
			// The page never sees option `value`s (anti-leak): the real value is
			// restored server-side from `index`, so echoing the label here is safe.
			value: input.dataset.label,
			index: Number(input.dataset.index),
		}));
		if (answers.length === 0) return null;
		return { dontKnow: false, note: note || undefined, answers };
	}

	async function submitAnswer() {
		if (submitting) return;
		const body = collectAnswer();
		if (!body) return;
		submitting = true;
		el.submit.disabled = true;
		el.submit.textContent = "Submitting…";
		try {
			const res = await fetch(answerUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (res.status === 200 || res.status === 409) {
				// 200 = accepted; 409 = another tab answered first — either way the
				// next poll brings the graded feedback.
				if (pollTimeout !== null) clearTimeout(pollTimeout);
				poll();
			} else if (res.status === 400) {
				showNotice("The answer was rejected as malformed — check a valid option and try again.");
				resetSubmit();
			} else {
				showNotice(`Submitting failed (HTTP ${res.status}) — try again.`);
				resetSubmit();
			}
		} catch {
			showNotice("Network error while submitting — try again.");
			resetSubmit();
		}
	}

	function resetSubmit() {
		submitting = false;
		el.submit.disabled = !anythingSelected();
		el.submit.textContent = "Submit";
	}

	function anythingSelected() {
		return el.dontKnow.checked || el.options.querySelector("input[name='answer']:checked") !== null;
	}

	// Delegated listeners on the persistent form (children are rebuilt per question).
	el.form.addEventListener("change", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target === el.dontKnow && el.dontKnow.checked) {
			// "I don't know" is exclusive with real selections (same as the TUI).
			for (const input of el.options.querySelectorAll("input[name='answer']")) input.checked = false;
		} else if (target.name === "answer" && target.checked) {
			el.dontKnow.checked = false;
		}
		el.notice.hidden = true;
		el.submit.disabled = !anythingSelected();
	});

	el.form.addEventListener("submit", (event) => {
		event.preventDefault();
		submitAnswer();
	});

	// ── start ──────────────────────────────────────────────────────────────────
	loadLibs();
	poll();
})();
