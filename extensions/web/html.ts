/**
 * Minimal dependency-free HTML parser for the DuckDuckGo HTML endpoint.
 *
 * Replaces linkedom: the only DOM surface web needs is three fixed
 * "tag.class" selectors plus getAttribute/textContent, and importing linkedom
 * cost ~110-130 ms on every pi startup for that. This module implements just
 * that subset — no CSS selector engine, no DOM events, no live trees.
 *
 * Deliberate scope (documented so nobody mistakes this for a general parser):
 * - Tokenizer + tree with a stack. Tolerant recovery: stray close tags are
 *   discarded; unmatched open tags stay open (no spec auto-closing like
 *   `<p>` / `<li>`, no table foster parenting). Machine-generated markup
 *   like DDG's parses exactly; pathological markup only needs to not crash.
 * - `<script>`/`<style>`/`<textarea>`/`<title>`/`<xmp>` content is raw text
 *   (so a JS string containing `<div class="result">` cannot leak a fake
 *   result into the tree).
 * - Void elements never go on the stack, self-closing or not.
 * - Comments, doctypes and processing instructions are skipped.
 * - Entities: numeric always; a curated subset of HTML5 named entities.
 *   Unknown named entities stay literal (cosmetic, not a failure).
 * - Attribute values follow HTML5 quoting: double/single-quoted (may contain
 *   `>`), unquoted (ends at whitespace or `>`; a trailing `/` is part of the
 *   value per spec). Attribute values are entity-decoded.
 */

const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr",
]);

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp"]);

/** Curated HTML5 named entities (real names only) + numeric forms are always handled. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">",
	quot: '"', QUOT: '"', apos: "'", nbsp: " ",
	iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥",
	brvbar: "¦", sect: "§", uml: "¨", copy: "©", COPY: "©",
	ordf: "ª", laquo: "«", not: "¬", shy: "­", reg: "®", REG: "®",
	macr: "¯", deg: "°", plusmn: "±", sup2: "²", sup3: "³", acute: "´",
	micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹",
	ordm: "º", raquo: "»", frac14: "¼", frac12: "½", frac34: "¾",
	iquest: "¿", times: "×", divide: "÷",
	Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
	Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É",
	Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î",
	Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó",
	Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù",
	Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", szlig: "ß",
	agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä",
	aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é",
	ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î",
	iuml: "ï", eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó",
	ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù",
	uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ",
	ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
	lrm: "‎", rlm: "‏", ndash: "–", mdash: "—", lsquo: "‘",
	rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
	dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰",
	prime: "′", Prime: "″", lsaquo: "‹", rsaquo: "›", oline: "‾",
	frasl: "⁄", euro: "€", trade: "™", TRADE: "™",
	larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔",
	minus: "−", lowast: "∗", infin: "∞", ne: "≠", equiv: "≡",
	le: "≤", ge: "≥",
};

export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	// `;` is optional (legacy HTML allows `&amp` / `&#39`), but the whole body
	// must match a known entity — no prefix matching, so `&ampersand` survives.
	return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X"
				? parseInt(body.slice(2), 16)
				: parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: match;
		}
		return NAMED_ENTITIES[body] ?? match;
	});
}

interface TextNode {
	text: string;
	/** Raw-text element content (script/style/...): entities are not decoded. */
	raw?: boolean;
}

export class MiniElement {
	readonly tag: string;
	readonly attrs: Record<string, string>;
	readonly children: (MiniElement | TextNode)[];

	constructor(tag: string, attrs: Record<string, string> = {}) {
		this.tag = tag;
		this.attrs = attrs;
		this.children = [];
	}

	/** "tag", "tag.class" or "tag.class.class" — the only grammar we need. */
	querySelectorAll(selector: string): MiniElement[] {
		const { tag, classes } = parseSelector(selector);
		const out: MiniElement[] = [];
		const visit = (el: MiniElement): void => {
			for (const child of el.children) {
				if (!("tag" in child)) continue;
				if (matches(child, tag, classes)) out.push(child);
				visit(child);
			}
		};
		visit(this);
		return out;
	}

	querySelector(selector: string): MiniElement | undefined {
		return this.querySelectorAll(selector)[0];
	}

	getAttribute(name: string): string | null {
		const value = this.attrs[name.toLowerCase()];
		return value === undefined ? null : value;
	}

	get textContent(): string {
		let out = "";
		const visit = (el: MiniElement): void => {
			for (const child of el.children) {
				if ("tag" in child) visit(child);
				else out += child.raw ? child.text : decodeEntities(child.text);
			}
		};
		visit(this);
		return out;
	}
}

function parseSelector(selector: string): { tag: string; classes: string[] } {
	const match = /^([a-zA-Z][a-zA-Z0-9]*)((?:\.[^\s.]+)*)$/.exec(selector.trim());
	if (!match) {
		throw new Error(`Unsupported selector (only "tag.class" is supported): ${selector}`);
	}
	return {
		tag: match[1].toLowerCase(),
		// Class matching is case-sensitive, like class selectors in the DOM.
		classes: match[2] ? match[2].slice(1).split(".") : [],
	};
}

function matches(el: MiniElement, tag: string, classes: string[]): boolean {
	if (el.tag !== tag) return false;
	if (classes.length === 0) return true;
	const own = (el.attrs.class ?? "").split(/\s+/);
	return classes.every((c) => own.includes(c));
}

/** Parses the open tag starting at `start` (which points at "<" of a real tag). */
function parseOpenTag(
	html: string,
	start: number,
): { tag: string; attrs: Record<string, string>; selfClosed: boolean; end: number } {
	let i = start + 1;
	while (i < html.length && /[a-zA-Z0-9]/.test(html[i])) i++;
	const tag = html.slice(start + 1, i).toLowerCase();
	const attrs: Record<string, string> = {};
	let selfClosed = false;

	while (i < html.length) {
		const ch = html[i];
		if (ch === ">") {
			i++;
			break;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r") {
			i++;
			continue;
		}
		if (ch === "/") {
			i++;
			if (html[i] === ">") {
				selfClosed = true;
				i++;
				break;
			}
			continue; // stray slash between attributes — ignored, like browsers do
		}

		// Attribute name: everything up to whitespace, "=", "/" or ">".
		const nameStart = i;
		while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
		const name = html.slice(nameStart, i).toLowerCase();
		if (!name) {
			i++; // defensive: skip a junk char instead of spinning
			continue;
		}

		let j = i;
		while (j < html.length && (html[j] === " " || html[j] === "\t" || html[j] === "\n" || html[j] === "\f" || html[j] === "\r")) j++;
		if (html[j] !== "=") {
			attrs[name] = "";
			continue; // value-less attribute; i still points after the name
		}
		i = j + 1;
		while (i < html.length && (html[i] === " " || html[i] === "\t" || html[i] === "\n" || html[i] === "\f" || html[i] === "\r")) i++;
		const quote = html[i];
		if (quote === '"' || quote === "'") {
			const close = html.indexOf(quote, i + 1);
			const value = close === -1 ? html.slice(i + 1) : html.slice(i + 1, close);
			attrs[name] = decodeEntities(value);
			i = close === -1 ? html.length : close + 1;
		} else {
			const valueStart = i;
			while (i < html.length && html[i] !== ">" && !/\s/.test(html[i])) i++;
			attrs[name] = decodeEntities(html.slice(valueStart, i));
		}
	}
	return { tag, attrs, selfClosed, end: i };
}

/**
 * Parses an HTML string into a synthetic `#document` element. The root never
 * matches a tag selector, so `parseHtml(html).querySelectorAll("div.x")`
 * searches the whole tree. Never throws on malformed input.
 */
export function parseHtml(html: string): MiniElement {
	const document = new MiniElement("#document");
	const stack: MiniElement[] = [document];

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			stack[stack.length - 1].children.push({ text: html.slice(i) });
			break;
		}
		if (lt > i) {
			stack[stack.length - 1].children.push({ text: html.slice(i, lt) });
		}

		// Comments (including the degenerate `<!-->` / `<!--->` forms), doctype,
		// CDATA and processing instructions: skip to the next `>` (comments to `-->`).
		if (html.startsWith("<!--", lt)) {
			if (html.startsWith("<!-->", lt)) {
				i = lt + 5;
			} else if (html.startsWith("<!--->", lt)) {
				i = lt + 6;
			} else {
				const end = html.indexOf("-->", lt + 4);
				i = end === -1 ? html.length : end + 3;
			}
			continue;
		}
		if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
			const end = html.indexOf(">", lt);
			i = end === -1 ? html.length : end + 1;
			continue;
		}

		// Close tag: pop to the nearest matching open tag, discard strays.
		if (html.startsWith("</", lt)) {
			const end = html.indexOf(">", lt);
			const tag = (end === -1 ? html.slice(lt + 2) : html.slice(lt + 2, end)).trim();
			const name = (tag.split(/\s+/)[0] ?? "").toLowerCase();
			if (name) {
				for (let s = stack.length - 1; s > 0; s--) {
					if (stack[s].tag === name) {
						stack.length = s;
						break;
					}
				}
			}
			i = end === -1 ? html.length : end + 1;
			continue;
		}

		// Open tag?
		if (!/[a-zA-Z]/.test(html[lt + 1] ?? "")) {
			// Lone "<" in text (e.g. "a < b").
			stack[stack.length - 1].children.push({ text: "<" });
			i = lt + 1;
			continue;
		}
		const { tag, attrs, selfClosed, end } = parseOpenTag(html, lt);
		i = end;

		const parent = stack[stack.length - 1];
		const el = new MiniElement(tag, attrs);
		parent.children.push(el);

		if (VOID_ELEMENTS.has(tag) || selfClosed) continue;

		if (RAW_TEXT_ELEMENTS.has(tag)) {
			const close = new RegExp(`</${tag}(?=[\\t\\n\\f />]|$)`, "i");
			close.lastIndex = i;
			const match = close.exec(html);
			const inner = match ? html.slice(i, match.index) : html.slice(i);
			if (inner) el.children.push({ text: inner, raw: true });
			const gt = match ? html.indexOf(">", match.index) : -1;
			i = gt === -1 ? html.length : gt + 1;
			continue;
		}

		stack.push(el);
	}
	return document;
}
