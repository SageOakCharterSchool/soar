/**
 * Link-preview (Open Graph) check for the Sage Oak dashboard:
 *   - Fetches the served homepage HTML and verifies it contains
 *     og:title, og:description, og:image, twitter:card, twitter:title,
 *     twitter:description and twitter:image meta tags
 *   - Verifies the descriptions are non-placeholder, Sage Oak-specific text
 *   - Fetches the og:image URL (/opengraph.jpg) and verifies it returns
 *     HTTP 200 with an image content type and a non-trivial body
 *
 * Runs against the dev server by default; requires the web dashboard
 * workflow to be running.
 */
const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");

let failures = 0;
function fail(msg: string) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}
function pass(msg: string) {
  console.log(`  ok: ${msg}`);
}

async function fetchHomepageHtml(): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${appBase}/`, {
        headers: { Accept: "text/html" },
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`homepage returned HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `Could not fetch homepage HTML from ${appBase}/ — is the web workflow running? (${String(
      lastErr,
    )})`,
  );
}

/**
 * Extract the content attribute of a <meta> tag identified by property=
 * or name=. Attribute order varies, so match the whole tag first.
 */
function metaContent(html: string, key: string): string | null {
  const tagRe = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(tagRe)) {
    const tag = m[0];
    const keyMatch = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    if (!keyMatch || keyMatch[1].toLowerCase() !== key.toLowerCase()) continue;
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    return contentMatch ? contentMatch[1] : "";
  }
  return null;
}

const PLACEHOLDER_PATTERNS = [
  /lorem ipsum/i,
  /placeholder/i,
  /\btodo\b/i,
  /\btbd\b/i,
  /your (app|site|description)/i,
  /description (goes )?here/i,
  /change ?me/i,
  /example\.com/i,
];

function checkDescription(label: string, value: string | null) {
  if (value === null) {
    fail(`${label} meta tag missing`);
    return;
  }
  if (value.trim().length < 20) {
    fail(`${label} too short to be a real description: ${JSON.stringify(value)}`);
    return;
  }
  const hit = PLACEHOLDER_PATTERNS.find((re) => re.test(value));
  if (hit) {
    fail(`${label} looks like placeholder text (matched ${hit}): ${JSON.stringify(value)}`);
    return;
  }
  if (!/sage oak/i.test(value)) {
    fail(`${label} does not mention Sage Oak: ${JSON.stringify(value)}`);
    return;
  }
  pass(`${label} is a real Sage Oak description`);
}

async function checkOgImage(imagePath: string) {
  const url = imagePath.startsWith("http")
    ? imagePath
    : `${appBase}${imagePath.startsWith("/") ? "" : "/"}${imagePath}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`could not fetch og image ${url}: ${String(err)}`);
    return;
  }
  if (res.status === 200) {
    pass(`og image ${imagePath} returned HTTP 200`);
  } else {
    fail(`og image ${imagePath} returned HTTP ${res.status}`);
    return;
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    pass(`og image content type is ${contentType}`);
  } else {
    fail(`og image content type is not an image: ${JSON.stringify(contentType)}`);
  }
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > 1024) {
    pass(`og image body is ${body.byteLength} bytes`);
  } else {
    fail(`og image body suspiciously small (${body.byteLength} bytes)`);
  }
}

async function main() {
  console.log(`Open Graph link-preview check against ${appBase}`);
  const html = await fetchHomepageHtml();

  console.log("\nMeta tags in served homepage HTML:");
  const ogTitle = metaContent(html, "og:title");
  if (ogTitle && ogTitle.trim().length > 0) {
    pass(`og:title present ("${ogTitle}")`);
  } else {
    fail(ogTitle === null ? "og:title meta tag missing" : "og:title is empty");
  }

  const twitterTitle = metaContent(html, "twitter:title");
  if (twitterTitle && twitterTitle.trim().length > 0) {
    pass(`twitter:title present ("${twitterTitle}")`);
  } else {
    fail(
      twitterTitle === null
        ? "twitter:title meta tag missing"
        : "twitter:title is empty",
    );
  }

  const twitterCard = metaContent(html, "twitter:card");
  if (twitterCard === "summary_large_image") {
    pass(`twitter:card is "summary_large_image"`);
  } else if (twitterCard === null) {
    fail("twitter:card meta tag missing");
  } else {
    fail(`twitter:card unexpected value: ${JSON.stringify(twitterCard)}`);
  }

  checkDescription("og:description", metaContent(html, "og:description"));
  checkDescription("twitter:description", metaContent(html, "twitter:description"));

  const ogImage = metaContent(html, "og:image");
  const twitterImage = metaContent(html, "twitter:image");
  if (ogImage && ogImage.trim().length > 0) {
    pass(`og:image present (${ogImage})`);
  } else {
    fail(ogImage === null ? "og:image meta tag missing" : "og:image is empty");
  }
  if (twitterImage && twitterImage.trim().length > 0) {
    pass(`twitter:image present (${twitterImage})`);
  } else {
    fail(
      twitterImage === null
        ? "twitter:image meta tag missing"
        : "twitter:image is empty",
    );
  }
  if (ogImage && twitterImage && ogImage !== twitterImage) {
    fail(`og:image (${ogImage}) and twitter:image (${twitterImage}) differ`);
  }

  console.log("\nServed image:");
  // Always verify the canonical /opengraph.jpg path, regardless of what the
  // meta tags say, so deleting the file can never slip through.
  await checkOgImage("/opengraph.jpg");
  if (
    ogImage &&
    ogImage.trim().length > 0 &&
    ogImage !== "/opengraph.jpg" &&
    !ogImage.endsWith("/opengraph.jpg")
  ) {
    fail(`og:image no longer points at /opengraph.jpg (${ogImage})`);
    await checkOgImage(ogImage);
  }

  if (failures > 0) {
    console.error(`\nOG PREVIEW CHECK FAILED: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOG preview check passed: shared links will show the Sage Oak card.");
}

main().catch((err) => {
  console.error(`OG PREVIEW CHECK ERRORED: ${err.message}`);
  process.exit(1);
});

export {};
