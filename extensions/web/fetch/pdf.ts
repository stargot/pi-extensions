/**
 * PDF URL detection and text extraction for web_fetch.
 *
 * Port of web-fetch's isPDF + extractPDF. unpdf (and its bundled pdf.js) is
 * loaded lazily inside extractPdf only — a module import here would make every
 * pi startup pay for pdf.js even when no PDF is ever fetched.
 *
 * Pure extraction, no pi-host imports. Errors from unpdf/pdf.js (corrupt or
 * encrypted files) propagate as thrown errors — the fetcher wraps this call.
 */

/** Hard page cap: long PDFs are truncated, not rejected (as in the source). */
const MAX_PDF_PAGES = 100;

/**
 * True when the URL or the response content-type indicates a PDF:
 * content-type wins ("application/pdf" anywhere in the header value), else
 * the URL pathname must end in ".pdf" case-insensitively. Unparseable URLs
 * are never PDFs.
 */
export function isPdfUrl(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

/**
 * Extract a PDF document as markdown.
 *
 * Reads document metadata (Title/Author) and per-page text, up to
 * MAX_PDF_PAGES pages; longer documents get a visible truncation marker
 * instead of a silent cut. The title falls back to the URL basename
 * (underscores/dashes spaced out), then to the literal "document".
 *
 * Throws on fetch-level problems already handled by the caller; throws
 * unpdf/pdf.js errors for corrupt or unsupported files.
 */
export async function extractPdf(
	buffer: ArrayBuffer | Uint8Array,
	url: string,
): Promise<{ title: string | null; markdown: string }> {
	// Lazy: pdf.js is heavy (several MB, slow first import) — pay only on PDFs.
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));

	const metadata = await pdf.getMetadata();
	const metadataInfo =
		metadata.info && typeof metadata.info === "object"
			? (metadata.info as Record<string, unknown>)
			: null;

	const metaTitle =
		typeof metadataInfo?.Title === "string" ? metadataInfo.Title.trim() : "";
	const metaAuthor =
		typeof metadataInfo?.Author === "string"
			? metadataInfo.Author.trim()
			: "";

	let urlTitle = "document";
	try {
		const { basename } = await import("node:path");
		urlTitle =
			basename(new URL(url).pathname, ".pdf")
				.replace(/[_-]+/g, " ")
				.trim() || "document";
	} catch {
		/* unparseable URL — keep "document" */
	}
	const title = metaTitle || urlTitle;

	const maxPages = Math.min(pdf.numPages, MAX_PDF_PAGES);
	const pages: string[] = [];
	for (let i = 1; i <= maxPages; i++) {
		const page = await pdf.getPage(i);
		const textContent = await page.getTextContent();
		const pageText = textContent.items
			.map((item: unknown) => (item as { str?: string }).str || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (pageText) pages.push(pageText);
	}

	const lines: string[] = [
		`# ${title}`,
		"",
		`> Source: ${url}`,
		`> Pages: ${pdf.numPages}${pdf.numPages > maxPages ? ` (extracted first ${maxPages})` : ""}`,
	];
	if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
	lines.push("", "---", "");
	lines.push(pages.join("\n\n"));

	if (pdf.numPages > maxPages) {
		lines.push(
			"",
			"---",
			"",
			`*[Truncated: Only first ${maxPages} of ${pdf.numPages} pages extracted]*`,
		);
	}

	return { title, markdown: lines.join("\n") };
}
