// Builds the page you host from src/app.html.
//   node build.mjs  ->  index.html (complete page for any static host)
// Note: this overwrites index.html, so put your Supabase settings in
// src/app.html too if you edit the source and rebuild.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("./src/app.html", import.meta.url), "utf8");
const [head, body] = src.split("<!-- BODY -->");
if (!body) throw new Error("src/app.html needs a <!-- BODY --> marker");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#14141b">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;

writeFileSync(new URL("./index.html", import.meta.url), page);
console.log(`index.html  ${(page.length / 1024).toFixed(1)} KB`);
