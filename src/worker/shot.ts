// A picture of a page, taken in a browser Cloudflare runs (Browser Run, through the BROWSER binding). Used for the
// previews of attempts being compared: the picture outlives the attempt, and the judges are shown it.
export const SHOT_MIME = "image/jpeg";

export async function takeShot(browser: unknown, url: string): Promise<Uint8Array> {
	// Loaded here so that code which never takes a picture (and the tests under Node) does not load a browser client.
	const { default: puppeteer } = await import("@cloudflare/puppeteer");
	const session = await puppeteer.launch(browser as any);
	try {
		const page = await session.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		// The same for every attempt wherever the browser runs: a page that follows the system's theme is pictured in the light one.
		await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
		const response = await page.goto(url, { waitUntil: "networkidle0", timeout: 25_000 });
		if (!response || !response.ok()) throw new Error(`the preview answered ${response?.status() ?? "nothing"}`);
		return (await page.screenshot({ type: "jpeg", quality: 72 })) as Uint8Array;
	} finally {
		await session.close().catch(() => {});
	}
}

/** Lets a sandboxed preview frame, or the browser taking a picture, load one ref without a cookie: the key travels in the path. */
export async function previewKey(token: string, slug: string, ref: string) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`preview:${slug}:${ref}`));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
