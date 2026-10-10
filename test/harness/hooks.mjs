const stub = new URL("./cloudflare.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
	if (specifier.startsWith("cloudflare:")) return { url: stub, shortCircuit: true };
	try {
		return await next(specifier, context);
	} catch (e) {
		if (e?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw e;
		return next(`${specifier}.ts`, context);
	}
}
