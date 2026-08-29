function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function localModuleHref(value: string): string | null {
  const href = value.trim();
  return href.startsWith("/") && !href.startsWith("//") ? href : null;
}

export function extractStaticModuleImports(source: string): string[] {
  const imports = [...source.matchAll(/(?:^|\n)import\s+[\s\S]*?\sfrom\s+"([^"]+)";/gu)]
    .map((match) => localModuleHref(match[1] ?? ""))
    .filter((href): href is string => href !== null);
  return [...new Set(imports)].slice(0, 200);
}

export function injectModulePreloads(indexHtml: string, moduleImports: string[]): string {
  const entry = indexHtml.match(/<script\s+type="module"\s+src="([^"]+)"/u)?.[1];
  const hrefs = [entry, ...moduleImports]
    .map((href) => localModuleHref(href ?? ""))
    .filter((href): href is string => href !== null);
  const uniqueHrefs = [...new Set(hrefs)].slice(0, 201);
  if (uniqueHrefs.length === 0 || !indexHtml.includes("</head>")) return indexHtml;
  const markup = uniqueHrefs
    .map((href) => `    <link rel="modulepreload" href="${escapeAttribute(href)}" fetchpriority="low">`)
    .join("\n");
  return indexHtml.replace("</head>", `${markup}\n  </head>`);
}
